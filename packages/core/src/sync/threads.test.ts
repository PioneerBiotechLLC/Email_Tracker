import { describe, expect, it } from "vitest";
import { containedIn, pickContainingThread, type CopyMessage } from "./threads.js";

const m = (id: string, mid: string | null, direction: "inbound" | "outbound" = "inbound", duplicateOfId: string | null = null): CopyMessage => ({ id, internetMessageId: mid, direction, duplicateOfId });
const rank = (threadId: string, messageCount: number, day: number) => ({ threadId, messageCount, mailboxCreatedAt: new Date(Date.UTC(2026, 9, day)) });

describe("containedIn", () => {
  it("is true when every email of the thread is in the other one, whichever mailbox holds the main copy", () => {
    const sales = [m("s1", "<a>", "inbound", "x1"), m("s2", "<b>", "inbound"), m("s3", "<c>", "outbound", "x3")];
    const marketing = [m("x1", "<a>"), m("x2", "<b>", "inbound", "s2"), m("x3", "<c>", "outbound"), m("x4", "<d>")];
    expect(containedIn(sales, marketing)).toBe(true);
    expect(containedIn(marketing, sales)).toBe(false); // <d> only in marketing: it stays visible
  });

  it("an email a colleague sent To this mailbox (not linked as a copy) is a request here, not a copy", () => {
    expect(containedIn([m("r1", "<m8>", "inbound")], [m("s1", "<m8>", "outbound")])).toBe(false);
    // a Cc'd copy of a colleague's outgoing email is linked to it, so it counts as contained
    expect(containedIn([m("r1", "<m9>", "inbound", "s1")], [m("s1", "<m9>", "outbound")])).toBe(true);
  });

  it("never matches emails without a Message-ID, or an empty thread", () => {
    expect(containedIn([m("a", null)], [m("b", null)])).toBe(false);
    expect(containedIn([], [m("b", "<a>")])).toBe(false);
  });
});

describe("pickContainingThread", () => {
  it("the largest thread represents the conversation; equal threads go to the mailbox registered first", () => {
    expect(pickContainingThread(rank("sales", 22, 2), [rank("marketing", 23, 5), rank("info", 23, 3)])).toBe("info");
    expect(pickContainingThread(rank("sales", 23, 2), [rank("marketing", 23, 5)])).toBeNull();
    expect(pickContainingThread(rank("marketing", 23, 5), [rank("sales", 23, 2)])).toBe("sales");
    expect(pickContainingThread(rank("sales", 23, 2), [])).toBeNull();
  });
});
