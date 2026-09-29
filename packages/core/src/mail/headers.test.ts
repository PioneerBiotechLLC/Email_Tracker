import { describe, expect, it } from "vitest";
import { extractReplyHeaders, parseMessageIds } from "./headers.js";

describe("headers", () => {
  it("parses In-Reply-To and References", () => {
    const h = extractReplyHeaders([
      { name: "In-Reply-To", value: "<abc@x.com>" },
      { name: "References", value: "<root@x.com>\r\n <abc@x.com>" },
    ]);
    expect(h.inReplyTo).toBe("<abc@x.com>");
    expect(h.references).toEqual(["<root@x.com>", "<abc@x.com>"]);
    expect(h.isAutoReply).toBe(false);
  });
  it("wraps bare ids in angle brackets", () => {
    expect(parseMessageIds("abc@x.com")).toEqual(["<abc@x.com>"]);
  });
  it("detects auto-replies from headers and subject", () => {
    expect(extractReplyHeaders([{ name: "Auto-Submitted", value: "auto-replied" }]).isAutoReply).toBe(true);
    expect(extractReplyHeaders([{ name: "X-Auto-Response-Suppress", value: "All" }]).isAutoReply).toBe(true);
    expect(extractReplyHeaders([{ name: "Auto-Submitted", value: "no" }]).isAutoReply).toBe(false);
    expect(extractReplyHeaders([], "Automatic reply: Out of office").isAutoReply).toBe(true);
    expect(extractReplyHeaders(null, "RE: PO").isAutoReply).toBe(false);
  });
});
