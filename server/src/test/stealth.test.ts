import { test } from "node:test";
import assert from "node:assert/strict";
import { STEALTH_SCRIPT, stealthEnabled } from "../stealth";

test("stealth script patches the common automation tells", () => {
    assert.match(STEALTH_SCRIPT, /navigator, 'webdriver'/);
    assert.match(STEALTH_SCRIPT, /hardwareConcurrency/);
    assert.match(STEALTH_SCRIPT, /UNMASKED_VENDOR_WEBGL|37445/);
    assert.match(STEALTH_SCRIPT, /permissions/);
});

test("stealth can be disabled with AETHER_STEALTH", () => {
    const original = process.env.AETHER_STEALTH;
    try {
        delete process.env.AETHER_STEALTH;
        assert.equal(stealthEnabled(), true);
        process.env.AETHER_STEALTH = "0";
        assert.equal(stealthEnabled(), false);
        process.env.AETHER_STEALTH = "false";
        assert.equal(stealthEnabled(), false);
        process.env.AETHER_STEALTH = "1";
        assert.equal(stealthEnabled(), true);
    } finally {
        if (original === undefined) delete process.env.AETHER_STEALTH;
        else process.env.AETHER_STEALTH = original;
    }
});
