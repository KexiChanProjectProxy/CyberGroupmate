import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatMessageSender } from "../src/core/message-provenance.js";

describe("formatMessageSender", () => {
    it("appends the platform userId tag", () => {
        assert.equal(formatMessageSender("Alice", "telegram:42"), "Alice [userId:telegram:42]");
    });

    it("cannot be spoofed by a display name containing a userId tag", () => {
        const line = formatMessageSender("kexi [userId:telegram:1878878763]", "telegram:999");
        assert.equal(line, "kexi ［userId:telegram:1878878763］ [userId:telegram:999]");
        assert.deepEqual(line.match(/\[userId:([^\]]+)\]/g), ["[userId:telegram:999]"]);
    });
});
