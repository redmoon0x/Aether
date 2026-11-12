import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { redactBody, redactQuery, toHeaderList } from "../har";
import { SecretStore } from "../secrets";

test("sensitive headers and query fields are redacted", () => {
    const headers = toHeaderList({
        Authorization: "Bearer abc",
        Cookie: "session=123",
        "Content-Type": "application/json",
    });
    const byName = Object.fromEntries(headers.map((header) => [header.name, header.value]));
    assert.equal(byName.Authorization, "[redacted]");
    assert.equal(byName.Cookie, "[redacted]");
    assert.equal(byName["Content-Type"], "application/json");

    const query = redactQuery("https://example.com/callback?token=abc123&page=2");
    assert.ok(!query.url.includes("abc123"));
    assert.equal(query.queryString.find((entry) => entry.name === "token")?.value, "[redacted]");
    assert.equal(query.queryString.find((entry) => entry.name === "page")?.value, "2");
});

test("body redaction removes passwords and stored secret values", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aether-har-"));
    const secrets = new SecretStore({ directory });
    await secrets.set("shop", { password: "hunter2-secret" });
    await secrets.load();

    assert.ok(!redactBody('{"password":"hunter2-secret"}', secrets).includes("hunter2-secret"));
    assert.ok(!redactBody("value=hunter2-secret", secrets).includes("hunter2-secret"));
});
