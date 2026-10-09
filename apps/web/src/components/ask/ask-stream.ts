import type { AskStreamEvent, AskTurn } from "@/lib/data/ask";

/** The body the Ask stream route accepts: one question plus its filters. */
export interface AskRequest {
  question: string;
  sessionId: string | null;
  deep: boolean;
  mailboxId: string | null;
  after: string | null;
  before: string | null;
  threadId: string | null;
}

export type AskResult = { ok: true; sessionId: string; turn: AskTurn } | { ok: false; message: string };

/** Sends one question to `<base>/stream` and reads its newline-delimited JSON: progress lines go to `onStatus`, the answer or error is returned. */
export async function streamAsk(base: string, body: AskRequest, onStatus: (text: string) => void): Promise<AskResult> {
  const res = await fetch(`${base}/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) return { ok: false, message: `The server answered ${res.status}.` };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let result: AskResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    buffer += value ?? "";
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const e = JSON.parse(line) as AskStreamEvent;
      if (e.type === "status") onStatus(e.text);
      else if (e.type === "error") result = { ok: false, message: e.message };
      else result = { ok: true, sessionId: e.sessionId, turn: e.turn };
    }
    if (done) break;
  }
  return result ?? { ok: false, message: "No answer arrived. Please try again." };
}
