import { describe, expect, it } from "vitest";
import { isAutoReplySubject, normalizeSubject } from "./subject.js";

describe("normalizeSubject", () => {
  it("strips nested reply/forward prefixes", () => {
    expect(normalizeSubject("RE: FW: Re: PO 4512 – Paracetamol 500mg")).toBe("po 4512 – paracetamol 500mg");
    expect(normalizeSubject("Fwd: quotation")).toBe("quotation");
    expect(normalizeSubject("RE[2]: quotation")).toBe("quotation");
  });
  it("strips Arabic prefixes", () => {
    expect(normalizeSubject("رد: عرض سعر")).toBe("عرض سعر");
    expect(normalizeSubject("إعادة توجيه: رد: عرض سعر")).toBe("عرض سعر");
  });
  it("drops bracketed ticket tags and collapses whitespace", () => {
    expect(normalizeSubject("[Ticket #1234]   Invoice   INV-88")).toBe("invoice inv-88");
    expect(normalizeSubject("RE: [EXTERNAL] Shipment update")).toBe("shipment update");
  });
  it("handles empty subjects", () => {
    expect(normalizeSubject("")).toBe("(no subject)");
    expect(normalizeSubject(null)).toBe("(no subject)");
  });
  it("strips automatic reply markers", () => {
    expect(normalizeSubject("Automatic reply: RE: PO 4512")).toBe("po 4512");
    expect(isAutoReplySubject("Automatic reply: hello")).toBe(true);
    expect(isAutoReplySubject("RE: hello")).toBe(false);
  });
});
