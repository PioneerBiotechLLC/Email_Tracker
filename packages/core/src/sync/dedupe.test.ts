import { describe, expect, it } from "vitest";
import { assignPrimaries, copyRank, domainOf, internalRecipients, orgDomains, pickPrimary, sameList, type MessageCopy } from "./dedupe.js";

const domains = orgDomains({ domain: "api-pharma.net", domains: ["API-Pharma.com", " "] });
const sales = new Set(["sales@api-pharma.net", "orders@api-pharma.net"]);

describe("internalRecipients", () => {
  it("collects To/Cc addresses in the company's domains, excluding the mailbox itself", () => {
    const r = internalRecipients(
      { to: [{ address: "Sales@API-Pharma.net" }, { address: "ali@customer.com" }], cc: [{ address: "Regulatory@api-pharma.net", name: "Reg" }, { address: "ceo@api-pharma.com" }, { address: "orders@api-pharma.net" }] },
      domains,
      sales,
    );
    expect(r).toEqual(["ceo@api-pharma.com", "regulatory@api-pharma.net"]);
  });
  it("is empty for external-only mail and tolerates missing addresses", () => {
    expect(internalRecipients({ to: [{ address: "ali@customer.com" }], cc: [{ address: "" }, {} as { address: string }] }, domains, sales)).toEqual([]);
    expect(domainOf("nobody")).toBe("");
    expect(sameList(["a"], ["a"])).toBe(true);
    expect(sameList(["a"], ["a", "b"])).toBe(false);
  });
});

function copy(p: Partial<MessageCopy> & { id: string; mailboxId: string }): MessageCopy {
  return {
    direction: "inbound", folder: "inbox", fromAddress: "ali@customer.com", toAddresses: [], ccAddresses: [], owners: new Set([`${p.mailboxId}@api-pharma.net`]),
    mailboxCreatedAt: new Date("2026-01-01T00:00:00Z"), ...p,
  };
}

describe("pickPrimary", () => {
  it("prefers the direct (To) recipient over a Cc'd mailbox", () => {
    const toSales = copy({ id: "s", mailboxId: "sales", toAddresses: [{ address: "sales@api-pharma.net" }], ccAddresses: [{ address: "regulatory@api-pharma.net" }] });
    const ccReg = copy({ id: "r", mailboxId: "regulatory", toAddresses: [{ address: "sales@api-pharma.net" }], ccAddresses: [{ address: "regulatory@api-pharma.net" }], mailboxCreatedAt: new Date("2025-01-01T00:00:00Z") });
    expect(pickPrimary([ccReg, toSales]).id).toBe("s");
    expect(copyRank(toSales)).toBeGreaterThan(copyRank(ccReg));
  });
  it("prefers the sender's Sent Items copy for outbound mail", () => {
    const sent = copy({ id: "sent", mailboxId: "sales", direction: "outbound", folder: "sent", fromAddress: "sales@api-pharma.net", toAddresses: [{ address: "regulatory@api-pharma.net" }] });
    const selfInbox = copy({ id: "inbox", mailboxId: "sales", direction: "outbound", folder: "inbox", fromAddress: "sales@api-pharma.net", toAddresses: [{ address: "sales@api-pharma.net" }] });
    expect(pickPrimary([selfInbox, sent]).id).toBe("sent");
  });
  it("breaks ties by the mailbox registered first, then deterministically", () => {
    const older = copy({ id: "b", mailboxId: "mb-b", mailboxCreatedAt: new Date("2025-06-01T00:00:00Z") });
    const newer = copy({ id: "a", mailboxId: "mb-a", mailboxCreatedAt: new Date("2026-06-01T00:00:00Z") });
    expect(pickPrimary([newer, older]).id).toBe("b");
    const twinA = copy({ id: "x2", mailboxId: "same" });
    const twinB = copy({ id: "x1", mailboxId: "same" });
    expect(pickPrimary([twinA, twinB]).id).toBe("x1");
    expect(pickPrimary([twinB, twinA]).id).toBe("x1");
  });
  it("an address that matches neither To nor Cc (distribution list) ranks lowest", () => {
    const viaList = copy({ id: "l", mailboxId: "info", toAddresses: [{ address: "everyone@api-pharma.net" }] });
    const cc = copy({ id: "c", mailboxId: "sales", ccAddresses: [{ address: "sales@api-pharma.net" }] });
    expect(pickPrimary([viaList, cc]).id).toBe("c");
  });
});

describe("assignPrimaries", () => {
  const sent = copy({ id: "sent", mailboxId: "sales", direction: "outbound", folder: "sent", fromAddress: "sales@api-pharma.net", toAddresses: [{ address: "ali@customer.com" }], ccAddresses: [{ address: "regulatory@api-pharma.net" }] });
  it("a Cc'd colleague's inbox copy of our outgoing reply-all is a copy of the Sent Items row", () => {
    const ccInbox = copy({ id: "cc", mailboxId: "regulatory", direction: "inbound", fromAddress: "sales@api-pharma.net", toAddresses: [{ address: "ali@customer.com" }], ccAddresses: [{ address: "regulatory@api-pharma.net" }] });
    expect(assignPrimaries([ccInbox, sent])).toEqual(new Map([["sent", null], ["cc", "sent"]]));
  });
  it("a colleague addressed directly (To) keeps a real inbound message", () => {
    const toInbox = copy({ id: "to", mailboxId: "regulatory", direction: "inbound", fromAddress: "sales@api-pharma.net", toAddresses: [{ address: "regulatory@api-pharma.net" }] });
    const sentTo = { ...sent, toAddresses: [{ address: "regulatory@api-pharma.net" }], ccAddresses: [] };
    expect(assignPrimaries([toInbox, sentTo])).toEqual(new Map([["sent", null], ["to", null]]));
  });
  it("two mailboxes that both received the same email share one primary", () => {
    const a = copy({ id: "a", mailboxId: "sales", toAddresses: [{ address: "sales@api-pharma.net" }], ccAddresses: [{ address: "regulatory@api-pharma.net" }] });
    const b = copy({ id: "b", mailboxId: "regulatory", toAddresses: [{ address: "sales@api-pharma.net" }], ccAddresses: [{ address: "regulatory@api-pharma.net" }] });
    expect(assignPrimaries([b, a])).toEqual(new Map([["a", null], ["b", "a"]]));
    expect(assignPrimaries([a])).toEqual(new Map([["a", null]]));
  });
});
