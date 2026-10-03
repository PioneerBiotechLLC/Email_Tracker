import { describe, expect, it } from "vitest";
import { networkErrorReason, withGraphRetry } from "./client.js";

const fetchFailed = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code }) });

describe("networkErrorReason", () => {
  it("names the cause of a failed connection", () => {
    expect(networkErrorReason(fetchFailed("ECONNRESET"))).toBe("ECONNRESET");
  });

  it("ignores HTTP errors and ordinary bugs", () => {
    expect(networkErrorReason(Object.assign(new Error("Bad request"), { statusCode: 400 }))).toBeNull();
    expect(networkErrorReason(new TypeError("x is not a function"))).toBeNull();
  });
});

describe("withGraphRetry", () => {
  it("retries a dropped connection", async () => {
    let calls = 0;
    const result = await withGraphRetry("test", async () => {
      calls += 1;
      if (calls === 1) throw fetchFailed("UND_ERR_SOCKET");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not retry a 400", async () => {
    let calls = 0;
    await expect(withGraphRetry("test", async () => {
      calls += 1;
      throw Object.assign(new Error("Bad request"), { statusCode: 400 });
    })).rejects.toThrow("Bad request");
    expect(calls).toBe(1);
  });
});
