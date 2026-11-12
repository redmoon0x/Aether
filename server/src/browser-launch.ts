/**
 * Browser process management: discover installed Chromium-family browsers,
 * enumerate profiles, and spawn one with `--remote-debugging-port` so the
 * Patchright driver can attach over CDP.
 *
 * This is the only part of the old CdpClient that survives: connection,
 * commands and input all moved to Playwright (see driver/).
 */
import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

export type BrowserName = "chrome" | "edge" | "brave" | "firefox";

export interface BrowserProfile {
    browser: BrowserName;
    id: string;
    name: string;
    directory: string;
    userDataDir: string;
    lastActive?: number;
}

export interface LaunchOptions {
    browser?: BrowserName;
    headless?: boolean;
    port?: number;
    profile?: string;
    profileDirectory?: string;
    userDataDir?: string;
    extraArgs?: string[];
}

const processes = new Map<number, ChildProcess>();

export function getBrowserPaths(): { name: BrowserName; paths: string[] }[] {
    const platform = os.platform();
    const chrome: string[] = [];
    const edge: string[] = [];
    const brave: string[] = [];
    const firefox: string[] = [];

    if (platform === "win32") {
        chrome.push(
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
        );
        edge.push(
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
        );
        brave.push(
            "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
            "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
        );
        firefox.push(
            "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
            "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"
        );
    } else if (platform === "darwin") {
        chrome.push(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium"
        );
        edge.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
        brave.push("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
        firefox.push("/Applications/Firefox.app/Contents/MacOS/firefox");
    } else {
        chrome.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium");
        edge.push("/usr/bin/microsoft-edge", "/snap/bin/microsoft-edge");
        brave.push("/usr/bin/brave-browser", "/snap/bin/brave");
        firefox.push("/usr/bin/firefox", "/snap/bin/firefox");
    }

    return [
        { name: "chrome", paths: chrome },
        { name: "edge", paths: edge },
        { name: "brave", paths: brave },
        { name: "firefox", paths: firefox },
    ];
}

export async function listAvailableBrowsers(): Promise<{ name: string; path: string }[]> {
    const available: { name: string; path: string }[] = [];
    for (const browser of getBrowserPaths()) {
        for (const candidate of browser.paths) {
            try {
                await fs.access(candidate);
                available.push({ name: browser.name, path: candidate });
                break;
            } catch {
                // try next
            }
        }
    }
    return available;
}

export function defaultUserDataDir(browser: BrowserName): string | null {
    const platform = os.platform();
    if (platform === "win32") {
        const local = process.env.LOCALAPPDATA;
        if (!local) return null;
        if (browser === "brave") return path.join(local, "BraveSoftware", "Brave-Browser", "User Data");
        if (browser === "chrome") return path.join(local, "Google", "Chrome", "User Data");
        if (browser === "edge") return path.join(local, "Microsoft", "Edge", "User Data");
        return null;
    }
    if (platform === "darwin") {
        const home = os.homedir();
        if (browser === "brave") return path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser");
        if (browser === "chrome") return path.join(home, "Library", "Application Support", "Google", "Chrome");
        if (browser === "edge") return path.join(home, "Library", "Application Support", "Microsoft Edge");
        return null;
    }
    const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    if (browser === "brave") return path.join(config, "BraveSoftware", "Brave-Browser");
    if (browser === "chrome") return path.join(config, "google-chrome");
    if (browser === "edge") return path.join(config, "microsoft-edge");
    return null;
}

export async function listBrowserProfiles(browser: BrowserName = "brave"): Promise<BrowserProfile[]> {
    const userDataDir = defaultUserDataDir(browser);
    if (!userDataDir) return [];

    let localState: any;
    try {
        localState = JSON.parse(await fs.readFile(path.join(userDataDir, "Local State"), "utf8"));
    } catch {
        return [];
    }

    const infoCache = localState?.profile?.info_cache || {};
    const ordered: string[] = localState?.profile?.profiles_order || Object.keys(infoCache);
    const profiles: BrowserProfile[] = [];

    for (const directory of ordered) {
        const cache = infoCache[directory] || {};
        try {
            const stat = await fs.stat(path.join(userDataDir, directory));
            if (!stat.isDirectory()) continue;
        } catch {
            continue;
        }
        profiles.push({
            browser,
            id: `${browser}:${directory}`,
            name: cache.name || cache.shortcut_name || directory,
            directory,
            userDataDir,
            lastActive: typeof cache.active_time === "number" ? cache.active_time : undefined,
        });
    }
    return profiles;
}

async function resolveProfile(options: LaunchOptions): Promise<{ userDataDir?: string; profileDirectory?: string }> {
    if (options.profileDirectory) {
        return { userDataDir: options.userDataDir, profileDirectory: options.profileDirectory };
    }
    const profile = options.profile?.trim();
    if (!profile) return { userDataDir: options.userDataDir };

    const browser = options.browser || "brave";
    const profiles = await listBrowserProfiles(browser);
    const needle = profile.toLowerCase();
    const match = profiles.find(
        (candidate) =>
            candidate.directory.toLowerCase() === needle ||
            candidate.name.toLowerCase() === needle ||
            candidate.id.toLowerCase() === `${browser}:${needle}`
    );
    if (!match) {
        const available = profiles.map((candidate) => `${candidate.name} (${candidate.directory})`).join(", ") || "none found";
        throw new Error(`Profile "${profile}" not found for ${browser}. Available profiles: ${available}`);
    }
    return { userDataDir: options.userDataDir || match.userDataDir, profileDirectory: match.directory };
}

async function waitForDevTools(port: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await new Promise<void>((resolve, reject) => {
                const request = require("http").get(`http://127.0.0.1:${port}/json/version`, (response: any) => {
                    response.resume();
                    resolve();
                });
                request.on("error", reject);
                request.setTimeout(1500, () => request.destroy(new Error("timeout")));
            });
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 400));
        }
    }
    throw new Error(`Browser did not expose a debugging port on ${port} within ${timeoutMs}ms`);
}

/**
 * Spawn a browser with remote debugging and return the port it listens on.
 * The caller connects with `chromium.connectOverCDP('http://127.0.0.1:<port>')`.
 */
export async function launchBrowserProcess(options: LaunchOptions = {}): Promise<{ port: number; browser: BrowserName }> {
    const port = options.port ?? 9222;
    let browserPath: string | null = null;
    let browserName = options.browser;

    if (browserName) {
        const entry = getBrowserPaths().find((candidate) => candidate.name === browserName);
        for (const candidate of entry?.paths ?? []) {
            try {
                await fs.access(candidate);
                browserPath = candidate;
                break;
            } catch {
                // try next
            }
        }
        if (!browserPath) throw new Error(`${browserName} not found. Install it or choose another browser.`);
    } else {
        const available = await listAvailableBrowsers();
        if (!available.length) {
            throw new Error("No supported browser found. Install Chrome, Edge, Brave, or Firefox.");
        }
        browserPath = available[0].path;
        browserName = available[0].name as BrowserName;
    }

    const profile = await resolveProfile({ ...options, browser: browserName });
    const userDataDir = profile.userDataDir ?? path.join(os.tmpdir(), `aether-${browserName}-profile`);
    const headless = options.headless ?? false;

    const args: string[] = [];
    if (browserName === "firefox") {
        args.push(
            "--remote-debugging-port", String(port),
            "--profile", userDataDir,
            ...(headless ? ["--headless"] : []),
            ...(options.extraArgs || []),
            "about:blank"
        );
    } else {
        args.push(
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${userDataDir}`,
            ...(profile.profileDirectory ? [`--profile-directory=${profile.profileDirectory}`] : []),
            "--disable-infobars",
            ...(headless ? ["--headless", "--disable-gpu"] : []),
            ...(options.extraArgs || []),
            "about:blank"
        );
    }

    const child = spawn(browserPath, args, { detached: false, stdio: "ignore" });
    processes.set(port, child);
    child.on("exit", () => processes.delete(port));

    await waitForDevTools(port);
    return { port, browser: browserName };
}

export function killLaunchedBrowser(port: number): boolean {
    const child = processes.get(port);
    if (!child) return false;
    try {
        if (os.platform() === "win32") {
            spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"]);
        } else {
            child.kill("SIGKILL");
        }
    } catch {
        // ignore
    }
    processes.delete(port);
    return true;
}

export function launchedPorts(): number[] {
    return [...processes.keys()];
}
