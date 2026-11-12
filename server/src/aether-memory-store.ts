import * as fs from "fs/promises";
import * as path from "path";

export type LessonStatus = "candidate" | "verified" | "promoted" | "retired";
export type SkillMaintenanceAction = "keep" | "patch" | "consolidate" | "prune";

export interface AetherMemoryConfig {
    maxLessons: number;
    maxLessonBytes: number;
    minConfidenceToPromote: number;
}

export interface LessonInput {
    title: string;
    trigger: string;
    problemPattern: string;
    betterApproach: string;
    createdBecause: string;
    projectRoot?: string;
    symptoms?: string[];
    failedApproach?: string;
    evidence?: string;
    tags?: string[];
    confidence?: number;
}

export interface LessonRecord extends Required<Omit<LessonInput, "projectRoot" | "confidence">> {
    id: string;
    kind: "lesson";
    fingerprint: string;
    confidence: number;
    uses: number;
    failures: number;
    status: LessonStatus;
    createdAt: string;
    updatedAt: string;
    lastVerified?: string;
}

export interface SkillInput {
    name: string;
    description: string;
    trigger: string;
    procedure: string[];
    projectRoot?: string;
    examples?: string[];
    edgeCases?: string[];
    verification?: string[];
}

export interface SkillRecord {
    name: string;
    description: string;
    status: "active" | "retired";
    uses: number;
    failures: number;
    createdAt: string;
    updatedAt: string;
    lastVerified?: string;
    maintenance: Array<{
        action: SkillMaintenanceAction;
        reason: string;
        timestamp: string;
    }>;
}

const DEFAULT_CONFIG: AetherMemoryConfig = {
    maxLessons: 500,
    maxLessonBytes: 5 * 1024 * 1024,
    minConfidenceToPromote: 0.82,
};

const RESERVED_NAMES = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "lpt1", "lpt2", "lpt3"]);

export class AetherMemoryStore {
    private configuredRoot?: string;

    canWrite(projectRoot?: string): boolean {
        return Boolean(projectRoot || this.configuredRoot || process.env.AETHER_PROJECT_ROOT);
    }

    async configure(projectRoot?: string): Promise<{ projectRoot: string; aetherDir: string; created: boolean }> {
        const root = await this.resolveProjectRoot(projectRoot, true);
        const aetherDir = this.aetherDir(root);
        const existed = await this.exists(aetherDir);

        await fs.mkdir(path.join(aetherDir, "memory"), { recursive: true });
        await fs.mkdir(path.join(aetherDir, "skills"), { recursive: true });
        await this.ensureConfig(root);
        await this.ensureGitignore(root);
        this.configuredRoot = root;

        return { projectRoot: root, aetherDir, created: !existed };
    }

    async rememberLesson(input: LessonInput): Promise<{ projectRoot: string; lesson: LessonRecord; merged: boolean }> {
        const root = await this.resolveProjectRoot(input.projectRoot, true);
        await this.configure(root);

        const now = new Date().toISOString();
        const lessons = await this.readLessons(root);
        const fingerprint = this.fingerprint([
            input.title,
            input.trigger,
            input.problemPattern,
            input.failedApproach || "",
            input.betterApproach,
        ]);
        const existing = lessons.find((lesson) => lesson.fingerprint === fingerprint);

        if (existing) {
            existing.confidence = this.clampConfidence(Math.max(existing.confidence, input.confidence ?? existing.confidence) + 0.03);
            existing.uses += 1;
            existing.status = this.promotedStatus(existing);
            existing.updatedAt = now;
            existing.lastVerified = now;
            existing.evidence = this.mergeText(existing.evidence, input.evidence);
            existing.tags = this.unique([...(existing.tags || []), ...(input.tags || [])]);
            await this.writeLessons(root, lessons);
            return { projectRoot: root, lesson: existing, merged: true };
        }

        const lesson: LessonRecord = {
            id: `lesson-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            kind: "lesson",
            title: input.title.trim(),
            trigger: input.trigger.trim(),
            problemPattern: input.problemPattern.trim(),
            symptoms: input.symptoms || [],
            failedApproach: input.failedApproach || "",
            betterApproach: input.betterApproach.trim(),
            createdBecause: input.createdBecause.trim(),
            evidence: input.evidence || "",
            tags: input.tags || [],
            fingerprint,
            confidence: this.clampConfidence(input.confidence ?? 0.65),
            uses: 1,
            failures: 0,
            status: "candidate",
            createdAt: now,
            updatedAt: now,
            lastVerified: now,
        };
        lesson.status = this.promotedStatus(lesson);
        lessons.push(lesson);
        await this.writeLessons(root, lessons);
        return { projectRoot: root, lesson, merged: false };
    }

    async recallLessons(query: {
        projectRoot?: string;
        intent?: string;
        problem?: string;
        tags?: string[];
        limit?: number;
    }): Promise<{ projectRoot: string; lessons: LessonRecord[] }> {
        const root = await this.resolveProjectRoot(query.projectRoot, false);
        const lessons = (await this.readLessons(root)).filter((lesson) => lesson.status !== "retired");
        const terms = this.tokenize([query.intent, query.problem, ...(query.tags || [])].filter(Boolean).join(" "));
        const scored = lessons
            .map((lesson) => ({ lesson, score: this.scoreLesson(lesson, terms) }))
            .filter((item) => terms.length === 0 || item.score > 0)
            .sort((a, b) => b.score - a.score || b.lesson.confidence - a.lesson.confidence || b.lesson.uses - a.lesson.uses)
            .slice(0, Math.max(1, Math.min(query.limit || 8, 25)))
            .map((item) => item.lesson);

        return { projectRoot: root, lessons: scored };
    }

    async recordLessonOutcome(params: {
        projectRoot?: string;
        id: string;
        success: boolean;
        evidence?: string;
    }): Promise<{ projectRoot: string; lesson: LessonRecord }> {
        const root = await this.resolveProjectRoot(params.projectRoot, false);
        const lessons = await this.readLessons(root);
        const lesson = lessons.find((item) => item.id === params.id);
        if (!lesson) throw new Error(`Unknown lesson: ${params.id}`);

        const now = new Date().toISOString();
        if (params.success) {
            lesson.uses += 1;
            lesson.confidence = this.clampConfidence(lesson.confidence + 0.05);
            lesson.lastVerified = now;
        } else {
            lesson.failures += 1;
            lesson.confidence = this.clampConfidence(lesson.confidence - 0.12);
            if (lesson.confidence < 0.25) lesson.status = "retired";
        }
        lesson.status = this.promotedStatus(lesson);
        lesson.updatedAt = now;
        lesson.evidence = this.mergeText(lesson.evidence, params.evidence);
        await this.writeLessons(root, lessons);
        return { projectRoot: root, lesson };
    }

    async createSkill(input: SkillInput): Promise<{ projectRoot: string; skillPath: string; skill: SkillRecord; created: boolean }> {
        const root = await this.resolveProjectRoot(input.projectRoot, true);
        await this.configure(root);
        const name = this.normalizeSkillName(input.name);
        const skillDir = path.join(this.aetherDir(root), "skills", name);
        const skillPath = path.join(skillDir, "SKILL.md");
        const existed = await this.exists(skillPath);

        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(skillPath, this.renderSkillMarkdown({ ...input, name }), "utf8");

        const registry = await this.readSkillRegistry(root);
        const now = new Date().toISOString();
        const existing = registry[name];
        const skill: SkillRecord = {
            name,
            description: input.description.trim(),
            status: "active",
            uses: existing?.uses || 0,
            failures: existing?.failures || 0,
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            lastVerified: existing?.lastVerified,
            maintenance: existing?.maintenance || [],
        };
        registry[name] = skill;
        await this.writeSkillRegistry(root, registry);
        return { projectRoot: root, skillPath, skill, created: !existed };
    }

    async listSkills(projectRoot?: string): Promise<{ projectRoot: string; skills: SkillRecord[] }> {
        const root = await this.resolveProjectRoot(projectRoot, false);
        const registry = await this.readSkillRegistry(root);
        return {
            projectRoot: root,
            skills: Object.values(registry).sort((a, b) => a.name.localeCompare(b.name)),
        };
    }

    async maintainSkill(params: {
        projectRoot?: string;
        name: string;
        action: SkillMaintenanceAction;
        reason: string;
        patchBody?: string;
        consolidateInto?: string;
    }): Promise<{ projectRoot: string; skill?: SkillRecord; removed?: string }> {
        const root = await this.resolveProjectRoot(params.projectRoot, false);
        const name = this.normalizeSkillName(params.name);
        const registry = await this.readSkillRegistry(root);
        const skill = registry[name];
        if (!skill) throw new Error(`Unknown skill: ${name}`);

        const now = new Date().toISOString();
        skill.maintenance.push({ action: params.action, reason: params.reason, timestamp: now });
        skill.updatedAt = now;

        if (params.action === "keep") {
            skill.lastVerified = now;
            skill.uses += 1;
        } else if (params.action === "patch") {
            if (params.patchBody) {
                const skillPath = path.join(this.aetherDir(root), "skills", name, "SKILL.md");
                await fs.writeFile(skillPath, params.patchBody, "utf8");
            }
        } else if (params.action === "consolidate") {
            const target = params.consolidateInto ? this.normalizeSkillName(params.consolidateInto) : undefined;
            if (!target) throw new Error("consolidateInto is required for consolidate");
            skill.status = "retired";
            skill.description = `Consolidated into ${target}. ${skill.description}`;
        } else if (params.action === "prune") {
            skill.status = "retired";
            const skillDir = path.join(this.aetherDir(root), "skills", name);
            await fs.rm(skillDir, { recursive: true, force: true });
            registry[name] = skill;
            await this.writeSkillRegistry(root, registry);
            return { projectRoot: root, skill, removed: skillDir };
        }

        registry[name] = skill;
        await this.writeSkillRegistry(root, registry);
        return { projectRoot: root, skill };
    }

    async compact(projectRoot?: string): Promise<{ projectRoot: string; lessonCount: number; learnedPath: string }> {
        const root = await this.resolveProjectRoot(projectRoot, false);
        const lessons = await this.readLessons(root);
        await this.writeLessons(root, lessons);
        return {
            projectRoot: root,
            lessonCount: lessons.filter((lesson) => lesson.status !== "retired").length,
            learnedPath: path.join(this.aetherDir(root), "memory", "learned.json"),
        };
    }

    private async resolveProjectRoot(projectRoot?: string, createAllowed: boolean = false): Promise<string> {
        const base = path.resolve(projectRoot || this.configuredRoot || process.env.AETHER_PROJECT_ROOT || process.cwd());
        const gitRoot = await this.findGitRoot(base);
        const root = gitRoot || base;
        if (!createAllowed && !(await this.exists(this.aetherDir(root)))) {
            throw new Error(`Aether memory is not configured for ${root}. Call memory {action:"configure"} with the project root first.`);
        }
        return root;
    }

    private async findGitRoot(start: string): Promise<string | undefined> {
        let current = start;
        try {
            const stat = await fs.stat(current);
            if (!stat.isDirectory()) current = path.dirname(current);
        } catch {
            current = path.dirname(current);
        }

        while (true) {
            if (await this.exists(path.join(current, ".git"))) return current;
            const parent = path.dirname(current);
            if (parent === current) return undefined;
            current = parent;
        }
    }

    private aetherDir(root: string): string {
        return path.join(root, ".aether");
    }

    private async ensureConfig(root: string): Promise<AetherMemoryConfig> {
        const configPath = path.join(this.aetherDir(root), "memory-config.json");
        if (await this.exists(configPath)) {
            const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
            return { ...DEFAULT_CONFIG, ...parsed };
        }
        await fs.writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
        return DEFAULT_CONFIG;
    }

    private async ensureGitignore(root: string): Promise<void> {
        const gitignorePath = path.join(root, ".gitignore");
        const line = ".aether/";
        let content = "";
        if (await this.exists(gitignorePath)) {
            content = await fs.readFile(gitignorePath, "utf8");
            if (content.split(/\r?\n/).some((item) => item.trim() === line)) return;
        }
        const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
        await fs.writeFile(gitignorePath, `${content}${prefix}${line}\n`, "utf8");
    }

    private async readLessons(root: string): Promise<LessonRecord[]> {
        const file = path.join(this.aetherDir(root), "memory", "lessons.jsonl");
        if (!(await this.exists(file))) return [];
        const text = await fs.readFile(file, "utf8");
        return text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line) as LessonRecord);
    }

    private async writeLessons(root: string, lessons: LessonRecord[]): Promise<void> {
        const config = await this.ensureConfig(root);
        const active = lessons
            .sort((a, b) => b.confidence - a.confidence || b.uses - a.uses || b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, config.maxLessons);
        let lines = active.map((lesson) => JSON.stringify(lesson));
        while (Buffer.byteLength(`${lines.join("\n")}\n`, "utf8") > config.maxLessonBytes && lines.length > 0) {
            lines.pop();
        }
        await fs.mkdir(path.join(this.aetherDir(root), "memory"), { recursive: true });
        await fs.writeFile(path.join(this.aetherDir(root), "memory", "lessons.jsonl"), `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
        await this.writeLearnedSummary(root, active);
    }

    private async writeLearnedSummary(root: string, lessons: LessonRecord[]): Promise<void> {
        const promoted = lessons
            .filter((lesson) => lesson.status === "promoted" || lesson.status === "verified")
            .sort((a, b) => b.confidence - a.confidence || b.uses - a.uses)
            .map((lesson) => ({
                id: lesson.id,
                title: lesson.title,
                trigger: lesson.trigger,
                problemPattern: lesson.problemPattern,
                betterApproach: lesson.betterApproach,
                confidence: lesson.confidence,
                uses: lesson.uses,
                failures: lesson.failures,
                lastVerified: lesson.lastVerified,
            }));
        await fs.writeFile(
            path.join(this.aetherDir(root), "memory", "learned.json"),
            `${JSON.stringify({ updatedAt: new Date().toISOString(), lessons: promoted }, null, 2)}\n`,
            "utf8"
        );
    }

    private async readSkillRegistry(root: string): Promise<Record<string, SkillRecord>> {
        const file = path.join(this.aetherDir(root), "skills", "_registry.json");
        if (!(await this.exists(file))) return {};
        return JSON.parse(await fs.readFile(file, "utf8"));
    }

    private async writeSkillRegistry(root: string, registry: Record<string, SkillRecord>): Promise<void> {
        await fs.mkdir(path.join(this.aetherDir(root), "skills"), { recursive: true });
        await fs.writeFile(path.join(this.aetherDir(root), "skills", "_registry.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    }

    private renderSkillMarkdown(input: SkillInput): string {
        const name = this.normalizeSkillName(input.name);
        const description = input.description.trim();
        const procedure = input.procedure.map((step, index) => `${index + 1}. ${step.trim()}`).join("\n");
        const examples = (input.examples || []).map((item) => `- ${item.trim()}`).join("\n");
        const edgeCases = (input.edgeCases || []).map((item) => `- ${item.trim()}`).join("\n");
        const verification = (input.verification || []).map((item) => `- ${item.trim()}`).join("\n");

        return [
            "---",
            `name: ${name}`,
            `description: ${this.yamlString(description)}`,
            "---",
            "",
            `# ${this.toTitle(name)}`,
            "",
            input.trigger.trim(),
            "",
            "## Procedure",
            "",
            procedure,
            "",
            ...(verification ? ["## Verify", "", verification, ""] : []),
            ...(edgeCases ? ["## Edge Cases", "", edgeCases, ""] : []),
            ...(examples ? ["## Examples", "", examples, ""] : []),
        ].join("\n");
    }

    private normalizeSkillName(name: string): string {
        const normalized = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64)
            .replace(/-+$/g, "");
        if (!normalized || RESERVED_NAMES.has(normalized)) {
            throw new Error(`Invalid skill name: ${name}`);
        }
        return normalized;
    }

    private toTitle(name: string): string {
        return name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
    }

    private yamlString(value: string): string {
        return JSON.stringify(value);
    }

    private promotedStatus(lesson: LessonRecord): LessonStatus {
        if (lesson.status === "retired") return "retired";
        if (lesson.confidence >= DEFAULT_CONFIG.minConfidenceToPromote && lesson.uses >= 3) return "promoted";
        if (lesson.confidence >= 0.72 || lesson.uses >= 2) return "verified";
        return "candidate";
    }

    private scoreLesson(lesson: LessonRecord, terms: string[]): number {
        if (terms.length === 0) return lesson.confidence + lesson.uses * 0.02;
        const haystack = this.tokenize([
            lesson.title,
            lesson.trigger,
            lesson.problemPattern,
            lesson.betterApproach,
            lesson.failedApproach,
            lesson.symptoms.join(" "),
            lesson.tags.join(" "),
        ].join(" "));
        const matched = terms.filter((term) => haystack.includes(term)).length;
        return matched + lesson.confidence + Math.min(lesson.uses, 10) * 0.05 - lesson.failures * 0.08;
    }

    private tokenize(text: string): string[] {
        return this.unique(text.toLowerCase().match(/[a-z0-9]+/g) || []);
    }

    private fingerprint(parts: string[]): string {
        return this.tokenize(parts.join(" ")).join("-");
    }

    private unique<T>(items: T[]): T[] {
        return Array.from(new Set(items.filter(Boolean)));
    }

    private clampConfidence(value: number): number {
        return Math.max(0, Math.min(1, Number(value.toFixed(2))));
    }

    private mergeText(current: string, next?: string): string {
        if (!next) return current || "";
        if (!current) return next;
        return current.includes(next) ? current : `${current}\n${next}`;
    }

    private async exists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }
}
