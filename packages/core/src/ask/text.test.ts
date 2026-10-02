import { describe, expect, it } from "vitest";
import { messageSearchText } from "./search-index.js";
import { searchPlans, searchText, snippet, tokenize } from "./text.js";

describe("tokenize", () => {
  it("splits letters from digits and drops every separator", () => {
    expect(tokenize("PO-4512")).toEqual(["po", "4512"]);
    expect(tokenize("PO#4512")).toEqual(["po", "4512"]);
    expect(tokenize("PO4512")).toEqual(["po", "4512"]);
    expect(tokenize("INV/2026/4512")).toEqual(["inv", "2026", "4512"]);
    expect(tokenize("Paracetamol 500mg (10x10), USD 0.92")).toEqual(["paracetamol", "500", "mg", "10", "x", "10", "usd", "0", "92"]);
    expect(tokenize("Ali.K@Customer.com")).toEqual(["ali", "k", "customer", "com"]);
    expect(tokenize(null)).toEqual([]);
  });
  it("every way of writing a reference shares the number token", () => {
    for (const v of ["4512", "PO 4512", "PO-4512", "PO#4512", "INV/2026/4512"]) expect(tokenize(v), v).toContain("4512");
  });
  it("normalizes Arabic: digits, diacritics, tatweel, alef/ya/ta-marbuta and the definite article", () => {
    expect(tokenize("٣٠٠٠ قلم")).toEqual(["3000", "قلم"]);
    expect(tokenize("الإنسولين")).toEqual(tokenize("انسولين"));
    expect(tokenize("إنسولين جلارجين ١٠٠ وحدة/مل")).toEqual(["انسولين", "جلارجين", "100", "وحده", "مل"]);
    expect(tokenize("مُحَمَّد")).toEqual(["محمد"]);
    expect(tokenize("شـــكراً")).toEqual(["شكرا"]);
    expect(tokenize("للمناقصة والمناقصة بالمناقصة")).toEqual(["مناقصه", "مناقصه", "مناقصه"]);
    expect(tokenize("الى")).toEqual(["الي"]); // too short to be article + word: left alone
  });
  it("does not stem: English plurals and Arabic words stay as written", () => {
    expect(tokenize("shipments shipped")).toEqual(["shipments", "shipped"]);
    expect(tokenize("مناقصات")).toEqual(["مناقصات"]);
  });
});

describe("searchText", () => {
  it("joins normalized tokens for to_tsvector('simple', …) and skips empty parts", () => {
    expect(searchText(["RE: PO-4512", null, "Ali <ali@x.com>", undefined, "Dispatch 12 Oct."])).toBe("re po 4512 ali ali x com dispatch 12 oct");
  });
  it("indexes subject, sender, recipients and (optionally) the body", () => {
    const m = { subject: "Tender 2026/117", fromName: "MOH Supplies", fromAddress: "tenders@moh.eg", to: [{ address: "sales@api-pharma.net" }], cc: [{ address: "regulatory@api-pharma.net" }] };
    expect(messageSearchText({ ...m, body: "technical file attached" })).toBe("tender 2026 117 moh supplies tenders moh eg sales api pharma net regulatory api pharma net technical file attached");
    expect(messageSearchText({ ...m, body: null })).not.toContain("technical");
  });
});

describe("searchPlans", () => {
  it("a bare number is one plan", () => expect(searchPlans("4512")).toEqual(["4512"]));
  it("reference variants: all terms first, then the number alone", () => {
    expect(searchPlans("PO 4512")).toEqual(["po & 4512", "4512", "po | 4512"]);
    expect(searchPlans("PO-4512")).toEqual(searchPlans("PO 4512"));
    expect(searchPlans("PO#4512")).toEqual(searchPlans("PO 4512"));
  });
  it("a year inside a reference is not the identifying number", () => {
    expect(searchPlans("INV/2026/4512")).toEqual(["inv & 2026 & 4512", "4512", "inv | 4512"]);
  });
  it("falls back to the year-like number when it is the only one", () => {
    expect(searchPlans("tender 2026")).toEqual(["tender & 2026", "2026", "tender"]);
  });
  it("several identifying numbers: all of them, then any of them", () => {
    expect(searchPlans("PO 4512 invoice 2210")).toEqual(["po & 4512 & invoice & 2210", "4512 & 2210", "4512 | 2210", "po | 4512 | invoice | 2210"]);
  });
  it("drops stop words and single letters; words fall back to any-of", () => {
    expect(searchPlans("What is the status of the Amoxicillin shipment?")).toEqual(["status & amoxicillin & shipment", "status | amoxicillin | shipment"]);
    expect(searchPlans("ما هو سعر الإنسولين")).toEqual(["سعر & انسولين", "سعر | انسولين"]);
    expect(searchPlans("the of a")).toEqual([]);
    expect(searchPlans("  ")).toEqual([]);
  });
  it("only ever emits letters, digits and the operators it adds itself", () => {
    for (const p of searchPlans("a:* | !b & (c) <-> 'd' \\ 4512:A")) expect(p).toMatch(/^[\p{L}\p{N}]+( [&|] [\p{L}\p{N}]+)*$/u);
  });
});

describe("snippet", () => {
  const long = `${"Intro sentence. ".repeat(30)}Dispatch of PO-4512 is expected on 12 Oct. ${"Closing words. ".repeat(30)}`;
  it("centres on the first matching term, whatever its punctuation", () => {
    const s = snippet(long, "PO#4512");
    expect(s.length).toBeLessThanOrEqual(302);
    expect(s).toContain("PO-4512 is expected on 12 Oct");
    expect(s.startsWith("…") && s.endsWith("…")).toBe(true);
  });
  it("returns short text whole and the start of the text when nothing matches", () => {
    expect(snippet("Thanks,\n  confirmed.", "4512")).toBe("Thanks, confirmed.");
    expect(snippet(long, "nomatch")).toMatch(/^Intro sentence\./);
    expect(snippet(long, undefined).length).toBeLessThanOrEqual(301);
  });
  it("matches Arabic regardless of article and spelling variants", () => {
    const ar = `${"نص تمهيدي طويل. ".repeat(30)}نرجو تزويدنا بعرض سعر الإنسولين خلال أسبوعين. ${"خاتمة. ".repeat(40)}`;
    expect(snippet(ar, "انسولين")).toContain("الإنسولين");
  });
});
