/**
 * Site secrets — values an agent can use without ever seeing them.
 *
 * A profile is a named set of key/value pairs scoped to origins. Values are
 * stored under `<state>/site-secrets/<name>.json` with mode 0600, are never
 * returned by list/status/type, and are scrubbed from execute output, HARs and
 * journals through {@link SecretStore.redact}.
 */
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";

export interface SecretProfile {
    name: string;
    origins: string[];
    values: Record<string, string>;
    createdAt: string;
    updatedAt: string;
}

export interface SecretProfileMeta {
    name: string;
    origins: string[];
    keys: string[];
    updatedAt: string;
}

export interface SecretRunResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

/** Environment variables a profile run may inherit; everything else is dropped. */
const ALLOWED_ENV = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
];

function safeName(name: string): string {
    const value = String(name ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!value) throw new Error("secret profile needs a name");
    return value;
}

function nowIso(): string {
    return new Date().toISOString();
}

export class SecretStore {
    private readonly directory: string;
    private readonly cache = new Map<string, SecretProfile>();
    private values: string[] = [];
    private loaded = false;

    constructor(options?: { directory?: string }) {
        const root = process.env.AETHER_SESSION_DIR || path.join(os.homedir(), ".aether");
        this.directory = options?.directory ?? path.join(root, "site-secrets");
    }

    private fileFor(name: string): string {
        return path.join(this.directory, `${safeName(name)}.json`);
    }

    async load(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const files = await fs.readdir(this.directory);
            for (const file of files) {
                if (!file.endsWith(".json")) continue;
                try {
                    const parsed = JSON.parse(await fs.readFile(path.join(this.directory, file), "utf8")) as SecretProfile;
                    if (parsed?.name && parsed.values && typeof parsed.values === "object") {
                        this.cache.set(parsed.name, parsed);
                    }
                } catch {
                    // A corrupt profile must not break every tool call.
                }
            }
        } catch {
            // No profiles yet.
        }
        this.rebuildValues();
    }

    private rebuildValues(): void {
        const values = new Set<string>();
        for (const profile of this.cache.values()) {
            for (const value of Object.values(profile.values)) {
                if (typeof value === "string" && value.length >= 4) values.add(value);
            }
        }
        // Longest first, so a secret containing a shorter secret is replaced whole.
        this.values = [...values].sort((left, right) => right.length - left.length);
    }

    private async persist(profile: SecretProfile): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const target = this.fileFor(profile.name);
        const temporary = `${target}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(profile, null, 2), { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, target);
        this.cache.set(profile.name, profile);
        this.rebuildValues();
    }

    async list(): Promise<SecretProfileMeta[]> {
        await this.load();
        return [...this.cache.values()]
            .map((profile) => ({
                name: profile.name,
                origins: profile.origins,
                keys: Object.keys(profile.values),
                updatedAt: profile.updatedAt,
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    async status(name: string): Promise<{ name: string; exists: boolean; keys: string[]; origins: string[] }> {
        await this.load();
        const key = safeName(name);
        const profile = this.cache.get(key);
        return {
            name: key,
            exists: !!profile,
            keys: profile ? Object.keys(profile.values) : [],
            origins: profile?.origins ?? [],
        };
    }

    async get(name: string): Promise<SecretProfile | null> {
        await this.load();
        return this.cache.get(safeName(name)) ?? null;
    }

    async set(name: string, values: Record<string, string>, origins: string[] = []): Promise<SecretProfileMeta> {
        await this.load();
        const key = safeName(name);
        const clean: Record<string, string> = {};
        for (const [entryKey, entryValue] of Object.entries(values ?? {})) {
            if (typeof entryValue === "string" && entryValue.length > 0) clean[entryKey] = entryValue;
        }
        if (!Object.keys(clean).length) throw new Error("secret profile needs at least one value");

        const existing = this.cache.get(key);
        const profile: SecretProfile = {
            name: key,
            origins: origins.length ? origins : existing?.origins ?? [],
            values: clean,
            createdAt: existing?.createdAt ?? nowIso(),
            updatedAt: nowIso(),
        };
        await this.persist(profile);
        return { name: key, origins: profile.origins, keys: Object.keys(profile.values), updatedAt: profile.updatedAt };
    }

    async remove(name: string): Promise<boolean> {
        await this.load();
        const key = safeName(name);
        try {
            await fs.unlink(this.fileFor(key));
        } catch {
            return false;
        }
        this.cache.delete(key);
        this.rebuildValues();
        return true;
    }

    /** Replace any known secret value with a placeholder. */
    redact(text: string): string {
        let output = String(text ?? "");
        for (const value of this.values) {
            if (value && output.includes(value)) output = output.split(value).join("[secret]");
        }
        return output;
    }

    /** Redact every string in an arbitrary result object before it reaches the model. */
    redactDeep<T>(value: T): T {
        const walk = (node: any): any => {
            if (typeof node === "string") return this.redact(node);
            if (Array.isArray(node)) return node.map(walk);
            if (node && typeof node === "object") {
                const out: Record<string, any> = {};
                for (const [key, entry] of Object.entries(node)) out[key] = walk(entry);
                return out;
            }
            return node;
        };
        return walk(value) as T;
    }

    /** Environment for a profile run: BC_SECRET_1..N plus an allowlisted base. */
    async envFor(name: string): Promise<Record<string, string>> {
        const profile = await this.get(name);
        if (!profile) throw new Error(`No secret profile named '${name}'.`);
        const env: Record<string, string> = {};
        for (const key of ALLOWED_ENV) {
            const value = process.env[key];
            if (typeof value === "string") env[key] = value;
        }
        Object.keys(profile.values)
            .sort()
            .forEach((key, index) => {
                env[`BC_SECRET_${index + 1}`] = profile.values[key];
            });
        return env;
    }

    /** Run a command with a profile's secrets in its environment, then redact output. */
    async run(name: string, command: string, args: string[] = [], timeoutMs = 60_000): Promise<SecretRunResult> {
        const env = await this.envFor(name);
        if (!command) throw new Error("secrets run needs a command");

        return await new Promise<SecretRunResult>((resolve) => {
            let stdout = "";
            let stderr = "";
            let timedOut = false;
            const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
            }, Math.max(1_000, Math.min(timeoutMs, 10 * 60_000)));

            child.stdout?.on("data", (chunk) => {
                if (stdout.length < 200_000) stdout += chunk.toString();
            });
            child.stderr?.on("data", (chunk) => {
                if (stderr.length < 200_000) stderr += chunk.toString();
            });
            child.on("error", (error) => {
                clearTimeout(timer);
                resolve({ code: null, stdout: this.redact(stdout), stderr: `${stderr}\n${String(error)}`.trim(), timedOut });
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                resolve({ code, stdout: this.redact(stdout), stderr: this.redact(stderr), timedOut });
            });
        });
    }
}

let store: SecretStore | null = null;

export function getSecretStore(options?: { directory?: string }): SecretStore {
    if (!store) store = new SecretStore(options);
    return store;
}
