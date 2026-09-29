import { describe, expect, it } from "vitest";
import { cleanBody, stripQuotedHistory, stripSignature } from "./text.js";

describe("stripQuotedHistory", () => {
  it("cuts at 'On ... wrote:'", () => {
    const t = "Yes, confirmed for Monday.\n\nOn Mon, 3 Mar 2025 at 10:00, Ali <ali@x.com> wrote:\n> Can we meet?";
    expect(stripQuotedHistory(t)).toBe("Yes, confirmed for Monday.\n");
  });
  it("cuts at an Outlook header block", () => {
    const t = "Please see below.\n\nFrom: Sara <sara@x.com>\nSent: Monday\nTo: me\nSubject: RE: PO\n\nold text";
    expect(stripQuotedHistory(t).trim()).toBe("Please see below.");
  });
  it("cuts at an Arabic Outlook header block", () => {
    const t = "تم الاستلام.\n\nمن: أحمد\nتاريخ الإرسال: الاثنين\nإلى: أنا\nالموضوع: عرض سعر\n\nنص قديم";
    expect(stripQuotedHistory(t).trim()).toBe("تم الاستلام.");
  });
  it("cuts at the Outlook divider and original message marker", () => {
    expect(stripQuotedHistory("new\n________________________________\nold").trim()).toBe("new");
    expect(stripQuotedHistory("new\n-----Original Message-----\nold").trim()).toBe("new");
  });
  it("does not cut a 'From:' that is not a header block", () => {
    const t = "From: our side we agree.\nThanks for the update.";
    expect(stripQuotedHistory(t)).toBe(t);
  });
});

describe("stripSignature", () => {
  it("removes an English sign-off block", () => {
    const t = "We can ship 500 units next week.\nPrice is USD 12.\n\nBest regards,\nOmar\nAPI Pharma\n+971 4 000 0000";
    expect(stripSignature(t).trim()).toBe("We can ship 500 units next week.\nPrice is USD 12.");
  });
  it("removes an Arabic sign-off block", () => {
    const t = "سنرسل الشحنة الأسبوع القادم.\nالسعر ١٢ دولار.\n\nمع خالص التحية\nعمر";
    expect(stripSignature(t).trim()).toBe("سنرسل الشحنة الأسبوع القادم.\nالسعر ١٢ دولار.");
  });
  it("keeps a message that is only a sign-off", () => {
    expect(stripSignature("Thanks,\nOmar")).toBe("Thanks,\nOmar");
  });
  it("removes mobile footers", () => {
    expect(stripSignature("Approved.\n\nSent from my iPhone").trim()).toBe("Approved.");
  });
});

describe("cleanBody", () => {
  it("converts html, strips history and caps length", () => {
    const html = "<div>Hello <b>there</b><br><br>On Mon Ali wrote:<br>&gt; old</div>";
    expect(cleanBody({ contentType: "html", content: html })).toBe("Hello there");
    const long = "x".repeat(9000);
    expect(cleanBody({ contentType: "text", content: long }).length).toBeLessThan(8100);
  });
  it("falls back to preview when body is empty", () => {
    expect(cleanBody(null, "preview text")).toBe("preview text");
  });
});
