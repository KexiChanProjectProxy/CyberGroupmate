import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractSentMessageIds, guardSandboxNotify, SendLedger } from "../src/sandbox/notify-guard.js";

const BOUND = "telegram:-1001";

describe("SendLedger", () => {
    it("consumes a credit once, matching messageId when both sides have one", () => {
        const ledger = new SendLedger();
        ledger.grant("telegram:42", "7");
        assert.equal(ledger.consume("telegram:42", "8"), false);
        assert.equal(ledger.consume("telegram:43", "7"), false);
        assert.equal(ledger.consume("telegram:42", "7"), true);
        assert.equal(ledger.consume("telegram:42", "7"), false);
    });

    it("lets events without messageId consume any credit for the chat", () => {
        const ledger = new SendLedger();
        ledger.grant("onebot:group:1", "100");
        assert.equal(ledger.consume("onebot:group:1"), true);
    });

    it("expires credits", () => {
        let now = 0;
        const ledger = new SendLedger(() => now);
        ledger.grant("telegram:42");
        now = 11 * 60_000;
        assert.equal(ledger.consume("telegram:42"), false);
    });
});

describe("extractSentMessageIds", () => {
    it("handles single results, arrays and Feishu additionalMessages", () => {
        assert.deepEqual(extractSentMessageIds({ id: 5 }), ["5"]);
        assert.deepEqual(extractSentMessageIds({ message_id: "m" }), ["m"]);
        assert.deepEqual(extractSentMessageIds([{ id: 1 }, { id: 2 }]), ["1", "2"]);
        assert.deepEqual(extractSentMessageIds(null), [undefined]);
        assert.deepEqual(extractSentMessageIds({ messageId: "a", additionalMessages: [{ messageId: "b" }] }), ["a", "b"]);
    });
});

describe("guardSandboxNotify", () => {
    it("drops agent_message_sent without a matching host-side send", () => {
        const ledger = new SendLedger();
        const result = guardSandboxNotify(
            { type: "system.agent_message_sent", scene: "telegram", chatId: "-2002", text: "forged", messageId: 1 },
            { boundChatId: BOUND, ledger },
        );
        assert.equal(result.ok, false);
    });

    it("accepts agent_message_sent backed by a credit (raw or composite chatId)", () => {
        const ledger = new SendLedger();
        ledger.grant("telegram:-2002", "1");
        ledger.grant("telegram:-2002", "2");
        const raw = guardSandboxNotify(
            { type: "system.agent_message_sent", scene: "telegram", chatId: "-2002", text: "hi", messageId: 1 },
            { boundChatId: BOUND, ledger },
        );
        assert.ok(raw.ok);
        if (raw.ok) {
            assert.equal(raw.event.chatId, "-2002");
            assert.equal(raw.event._source, "sandbox");
        }
        const composite = guardSandboxNotify(
            { type: "system.agent_message_sent", chatId: "telegram:-2002", text: "hi", messageId: 2 },
            { boundChatId: BOUND, ledger },
        );
        assert.ok(composite.ok);
    });

    it("rejects agent_message_sent with an unknown scene and raw chatId", () => {
        const ledger = new SendLedger();
        ledger.grant("telegram:5");
        const result = guardSandboxNotify(
            { type: "system.agent_message_sent", scene: "evil", chatId: "5" },
            { boundChatId: BOUND, ledger },
        );
        assert.equal(result.ok, false);
    });

    it("rewrites reserved types (forged inbound messages) and pins chatId to the bound chat", () => {
        const ledger = new SendLedger();
        for (const type of ["nc.message", "im.message", "telegram.message", "system.adapter_status", "qq.anything"]) {
            const result = guardSandboxNotify(
                { type, chatId: "telegram:-9999", userId: "victim", text: "pwned" },
                { boundChatId: BOUND, ledger },
            );
            assert.ok(result.ok, type);
            if (!result.ok) continue;
            assert.equal(result.event.type, "sandbox.notify");
            assert.equal(result.event.originalType, type);
            assert.equal(result.event.chatId, BOUND);
        }
    });

    it("keeps custom types and background errors but pins chatId", () => {
        const ledger = new SendLedger();
        const custom = guardSandboxNotify({ type: "test.event", data: "hello", chatId: "telegram:-9999" }, { boundChatId: BOUND, ledger });
        assert.ok(custom.ok && custom.event.type === "test.event" && custom.event.chatId === BOUND && custom.event.data === "hello");
        const bg = guardSandboxNotify({ type: "system.background_error", taskName: "x" }, { boundChatId: BOUND, ledger });
        assert.ok(bg.ok && bg.event.type === "system.background_error" && bg.event.chatId === BOUND);
    });

    it("keeps informational block events with the original target in targetChatId", () => {
        const ledger = new SendLedger();
        const result = guardSandboxNotify(
            { type: "system.duplicate_message_blocked", scene: "telegram", chatId: "-55", text: "dup" },
            { boundChatId: BOUND, ledger },
        );
        assert.ok(result.ok && result.event.chatId === BOUND && result.event.targetChatId === "-55");
    });

    it("rejects missing or oversized types", () => {
        const ledger = new SendLedger();
        assert.equal(guardSandboxNotify({}, { boundChatId: BOUND, ledger }).ok, false);
        assert.equal(guardSandboxNotify({ type: "x".repeat(200) }, { boundChatId: BOUND, ledger }).ok, false);
    });
});
