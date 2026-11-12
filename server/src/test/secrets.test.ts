import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { SecretStore } from "../secrets";

async function store(): Promise<SecretStore> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aether-secrets-"));
    return new SecretStore({ directory });
}

test("stores values without exposing them in list or status", async () => {
    const secrets = await store();
    await secrets.set("shop", { password: "hunter2-donotprint", apiKey: "sk-1234567890123456" }, ["https://shop.example"]);

    const list = await secrets.list();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].keys.sort(), ["apiKey", "password"]);
    assert.ok(!JSON.stringify(list).includes("hunter2"));

    const status = await secrets.status("shop");
    assert.equal(status.exists, true);
    assert.ok(!JSON.stringify(status).includes("hunter2"));
});

test("redacts known values and deep results", async () => {
    const secrets = await store();
    await secrets.set("shop", { password: "hunter2-donotprint" });
    await secrets.load();

    assert.equal(secrets.redact("the value is hunter2-donotprint here"), "the value is [secret] here");
    const deep = secrets.redactDeep({ stdout: "hunter2-donotprint", nested: ["hunter2-donotprint"] });
    assert.equal(deep.stdout, "[secret]");
    assert.equal(deep.nested[0], "[secret]");
});

test("envFor maps secrets and drops unrelated environment", async () => {
    const secrets = await store();
    await secrets.set("api", { token: "super-secret-token" });
    process.env.AETHER_UNRELATED = "should-not-pass";
    try {
        const env = await secrets.envFor("api");
        assert.equal(env.BC_SECRET_1, "super-secret-token");
        assert.equal(env.AETHER_UNRELATED, undefined);
    } finally {
        delete process.env.AETHER_UNRELATED;
    }
});

test("run executes with a secret and redacts its output", async () => {
    const secrets = await store();
    await secrets.set("api", { token: "super-secret-token" });
    const result = await secrets.run(
        "api",
        process.execPath,
        ["-e", "process.stdout.write(process.env.BC_SECRET_1 || '')"],
        15_000
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "[secret]");
    assert.ok(!result.stdout.includes("super-secret-token"));
});

test("remove deletes a profile", async () => {
    const secrets = await store();
    await secrets.set("temp", { value: "abc123" });
    assert.equal(await secrets.remove("temp"), true);
    assert.equal((await secrets.list()).length, 0);
});
