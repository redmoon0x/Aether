/**
 * Named browser sessions.
 *
 * A session is a name, a durable pin to a browser + tab, and a small journal.
 * It survives an MCP restart. The current session is tracked per *caller*:
 * when the MCP client names the agent (OpenCode's `_meta` session id), each
 * agent has its own current session, so one agent's `session_new` does not
 * move another's page. Clients that do not name agents share one.
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export interface SessionTarget {
    browserId?: string;
    targetId?: string;
    urlIncludes?: string;
    title?: string;
}

export interface JournalEntry {
    at: string;
    kind: string;
    detail?: string;
}

export interface SessionRecord {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string;
    target?: SessionTarget;
    readOnly?: boolean;
    allowedOrigins?: string[];
    journal: JournalEntry[];
}

interface StoredFile {
    version: 2;
    currentByCaller: Record<string, string>;
    sessions: SessionRecord[];
}

const MAX_SESSIONS = 50;
const MAX_JOURNAL = 200;
const JOURNAL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function nowIso(): string {
    return new Date().toISOString();
}

function slugify(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return slug || "session";
}

/** Keep credentials out of the journal: typed values never belong there. */
function redact(detail: string): string {
    return detail
        .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]")
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
        .replace(/(password|passwd|token|secret|otp|code)\s*[:=]\s*\S+/gi, "$1=[redacted]")
        .slice(0, 300);
}

export class SessionManager {
    private readonly filePath: string;
    private currentByCaller = new Map<string, string>();
    private sessions: SessionRecord[] = [];
    private loaded = false;

    constructor(options?: { directory?: string }) {
        const directory =
            options?.directory ??
            process.env.AETHER_SESSION_DIR ??
            path.join(os.homedir(), ".aether");
        this.filePath = path.join(directory, "sessions.json");
    }

    async load(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;

        try {
            const raw = await fs.readFile(this.filePath, "utf8");
            const parsed = JSON.parse(raw) as Partial<StoredFile> & { current?: string };
            if (Array.isArray(parsed?.sessions)) {
                this.sessions = parsed.sessions.filter((session) => session && typeof session.id === "string");
            }
            if (parsed?.currentByCaller && typeof parsed.currentByCaller === "object") {
                for (const [caller, id] of Object.entries(parsed.currentByCaller)) {
                    if (typeof id === "string") this.currentByCaller.set(caller, id);
                }
            } else if (typeof parsed?.current === "string") {
                this.currentByCaller.set("shared", parsed.current);
            }
        } catch {
            // No store yet, or unreadable: start empty rather than fail a tool call.
        }

        if (!this.sessions.length) {
            this.sessions.push(this.makeRecord(process.env.AETHER_SESSION || "default", "default"));
        }
    }

    private makeRecord(id: string, name: string): SessionRecord {
        const at = nowIso();
        return { id, name, createdAt: at, lastUsedAt: at, journal: [] };
    }

    private async persist(): Promise<void> {
        if (this.sessions.length > MAX_SESSIONS) {
            this.sessions = [...this.sessions]
                .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))
                .slice(0, MAX_SESSIONS);
        }

        const payload: StoredFile = {
            version: 2,
            currentByCaller: Object.fromEntries(this.currentByCaller),
            sessions: this.sessions,
        };
        const directory = path.dirname(this.filePath);
        const temporary = `${this.filePath}.${process.pid}.tmp`;
        try {
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
            await fs.rename(temporary, this.filePath);
        } catch {
            // A session that cannot be written still works for this process.
        }
    }

    currentId(caller: string = "shared"): string {
        const id = this.currentByCaller.get(caller);
        if (id && this.get(id)) return id;
        const fallback = this.sessions[0]?.id ?? "default";
        this.currentByCaller.set(caller, fallback);
        return fallback;
    }

    currentSession(caller: string = "shared"): SessionRecord | null {
        return this.get(this.currentId(caller));
    }

    get(id: string): SessionRecord | null {
        return this.sessions.find((session) => session.id === id) ?? null;
    }

    list(): SessionRecord[] {
        return [...this.sessions].sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
    }

    async create(name: string, caller: string = "shared"): Promise<SessionRecord> {
        await this.load();
        const base = slugify(name);
        let id = base;
        let counter = 2;
        while (this.get(id)) id = `${base}-${counter++}`;

        const record = this.makeRecord(id, name || base);
        this.sessions.push(record);
        this.currentByCaller.set(caller, id);
        await this.persist();
        return record;
    }

    async use(id: string, caller: string = "shared"): Promise<SessionRecord> {
        await this.load();
        const record = this.get(id);
        if (!record) throw new Error(`Session not found: ${id}. Create it with sessions {action:"new"} first.`);
        this.currentByCaller.set(caller, id);
        record.lastUsedAt = nowIso();
        await this.persist();
        return record;
    }

    async reset(id?: string, caller: string = "shared"): Promise<SessionRecord> {
        await this.load();
        const record = this.get(id ?? this.currentId(caller));
        if (!record) throw new Error(`Session not found: ${id ?? this.currentId(caller)}`);
        record.target = undefined;
        record.lastUsedAt = nowIso();
        record.journal = [];
        await this.persist();
        return record;
    }

    async delete(id?: string, caller: string = "shared"): Promise<{ deleted: string; current: string }> {
        await this.load();
        const target = id ?? this.currentId(caller);
        const before = this.sessions.length;
        this.sessions = this.sessions.filter((session) => session.id !== target);
        if (this.sessions.length === before) throw new Error(`Session not found: ${target}`);

        if (!this.sessions.length) this.sessions.push(this.makeRecord("default", "default"));
        for (const [key, value] of this.currentByCaller) {
            if (value === target) this.currentByCaller.delete(key);
        }
        if (!this.sessions.some((session) => session.id === this.currentId(caller))) {
            this.currentByCaller.set(caller, this.sessions[0].id);
        }
        await this.persist();
        return { deleted: target, current: this.currentId(caller) };
    }

    async bind(id: string | undefined, target: SessionTarget, caller: string = "shared"): Promise<SessionRecord> {
        await this.load();
        const record = this.get(id ?? this.currentId(caller));
        if (!record) throw new Error(`Session not found: ${id ?? this.currentId(caller)}`);
        record.target = target;
        record.lastUsedAt = nowIso();
        await this.persist();
        return record;
    }

    async record(id: string | undefined, kind: string, detail?: string, caller: string = "shared"): Promise<void> {
        const record = this.get(id ?? this.currentId(caller));
        if (!record) return;
        record.lastUsedAt = nowIso();
        record.journal.push({ at: nowIso(), kind, ...(detail ? { detail: redact(detail) } : {}) });

        const cutoff = Date.now() - JOURNAL_MAX_AGE_MS;
        record.journal = record.journal.filter((entry) => Date.parse(entry.at) >= cutoff).slice(-MAX_JOURNAL);
        await this.persist();
    }
}

let manager: SessionManager | null = null;

export function getSessionManager(): SessionManager {
    if (!manager) manager = new SessionManager();
    return manager;
}
