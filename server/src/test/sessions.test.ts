import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { SessionManager } from "../sessions";

async function freshManager(): Promise<SessionManager> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aether-sessions-"));
    return new SessionManager({ directory });
}

test("each caller has its own current session", async () => {
    const manager = await freshManager();
    const alpha = await manager.create("alpha", "caller-a");
    assert.equal(manager.currentId("caller-a"), alpha.id);

    // A different caller is unaffected by caller A's create.
    const sharedBefore = manager.currentId("caller-b");
    assert.notEqual(sharedBefore, alpha.id);

    const beta = await manager.create("beta", "caller-b");
    assert.equal(manager.currentId("caller-b"), beta.id);
    assert.equal(manager.currentId("caller-a"), alpha.id);
});

test("session reuse works through use and reset", async () => {
    const manager = await freshManager();
    const first = await manager.create("first", "caller");
    await manager.create("second", "caller");
    assert.notEqual(manager.currentId("caller"), first.id);

    await manager.use(first.id, "caller");
    assert.equal(manager.currentId("caller"), first.id);

    await manager.bind(first.id, { browserId: "chrome-1", targetId: "chrome-1:9" }, "caller");
    assert.equal(manager.get(first.id)?.target?.targetId, "chrome-1:9");

    const reset = await manager.reset(first.id, "caller");
    assert.equal(reset.target, undefined);
});

test("journal redacts credential-looking values and caps detail", async () => {
    const manager = await freshManager();
    const record = await manager.create("journal", "caller");
    await manager.record(record.id, "execute", "password=SuperSecret123 token=abcdef0123456789abcdef0123456789", "caller");

    const entry = manager.get(record.id)!.journal.at(-1)!;
    assert.match(entry.detail ?? "", /\[redacted\]/);
    assert.ok(!(entry.detail ?? "").includes("SuperSecret123"));
});
