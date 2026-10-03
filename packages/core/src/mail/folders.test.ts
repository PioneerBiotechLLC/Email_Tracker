import { describe, expect, it } from "vitest";
import { looksLikeSentFolder } from "./folders.js";

describe("looksLikeSentFolder", () => {
  it("recognizes the names a Zoho migration leaves behind", () => {
    for (const name of ["Sent", "sent", "Sent Emails", "Emails Sent", "Sent Mail", "Sent-Mail", "Sent_Items", "  SENT  ", "العناصر المرسلة"]) {
      expect(looksLikeSentFolder(name), name).toBe(true);
    }
  });

  it("leaves other folders alone", () => {
    for (const name of ["Inbox", "Drafts", "Sent to customers", "Unsent", "Archive", "Deleted Items"]) {
      expect(looksLikeSentFolder(name), name).toBe(false);
    }
  });
});
