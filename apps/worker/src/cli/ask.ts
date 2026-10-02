import { Command } from "commander";
import { answerQuestion, disconnectDb, getDb, getEnv, hasAnthropicKey, type SessionContext } from "@email-tracker/core";

const program = new Command().name("ask").description("Ask chat: evaluation against the demo data");

interface EvalCase {
  question: string;
  /** part of the subject of the thread the answer must cite; null = the right answer is "not found" */
  expect: string | null;
  /** asked in the same chat as the previous case */
  followUp?: boolean;
}

const CASES: EvalCase[] = [
  { question: "What happened to PO 4512?", expect: "PO 4512 – Amoxicillin" },
  { question: "When will it be delivered?", expect: "PO 4512 – Amoxicillin", followUp: true },
  { question: "Is shipment AWB 1234-5678 still held at customs, and what do they need from us?", expect: "Shipment AWB 1234-5678" },
  { question: "What is the new price of Ceftriaxone 1g vials and from when does it apply?", expect: "Ceftriaxone 1g vials" },
  { question: "Latest update from Hetero about the COA for batch PCM-2309?", expect: "COA for batch PCM-2309" },
  { question: "Which invoice is Sun Pharma chasing us for, and how much is it?", expect: "Payment reminder – INV-2188" },
  { question: "ما هو طلب أحمد خليل بخصوص الإنسولين؟", expect: "إنسولين جلارجين" },
  { question: "What does MOHAP still need for the Metformin registration MR-2026-118?", expect: "MOHAP registration – Metformin" },
  { question: "Any update on tender 2026/117?", expect: "Tender 2026/117" },
  { question: "When is the cold room stock count and what should sales do?", expect: "stock count Q4" },
  { question: "By when do we have to submit the controlled substances forecast for the import permit?", expect: "Import permit renewal" },
  { question: "What is the status of our Lipitor order with Pfizer?", expect: null },
];

const usd = (n: number) => `$${n.toFixed(4)}`;

program
  .command("eval")
  .description(`Asks ${CASES.length} fixed questions against the demo company (pnpm db:seed-demo) and checks that each answer cites the right thread. Uses the real Claude API: costs money, needs ANTHROPIC_API_KEY.`)
  .option("--deep", "use the deep model (ANTHROPIC_CHAT_DEEP_MODEL) instead of the default chat model", false)
  .option("--org <slug>", "demo company slug", "demo-pharma")
  .action(async (opts: { deep: boolean; org: string }) => {
    if (!hasAnthropicKey()) throw new Error("ANTHROPIC_API_KEY is not set: the eval only runs against the real API.");
    const db = getDb();
    const org = await db.organization.findUnique({ where: { slug: opts.org }, include: { memberships: { include: { user: true }, where: { role: "admin" }, take: 1 } } });
    if (!org?.isDemo || !org.memberships[0]) throw new Error(`Demo company "${opts.org}" not found. Run pnpm db:seed-demo first (the eval's expected answers are written for the demo data).`);
    const user = org.memberships[0].user;
    const ctx: SessionContext = { userId: user.id, email: user.email, orgId: org.id, role: "admin" };
    const threads = await db.thread.findMany({ where: { mailbox: { orgId: org.id } }, select: { id: true, subject: true } });
    const env = getEnv();
    console.log(`\nAsk eval — ${org.name}, model ${opts.deep ? env.ANTHROPIC_CHAT_DEEP_MODEL : env.ANTHROPIC_CHAT_MODEL}\n`);

    let passed = 0;
    let cost = 0;
    let sessionId: string | null = null;
    for (const [i, c] of CASES.entries()) {
      const r = await answerQuestion(db, { ctx, question: c.question, deep: opts.deep, sessionId: c.followUp ? sessionId : null });
      if (!r.ok) throw new Error(`Question ${i + 1} was not asked: ${r.message}`);
      sessionId = r.sessionId;
      cost += r.costUsd;
      const wanted = c.expect ? threads.filter((t) => t.subject.includes(c.expect!)).map((t) => t.id) : [];
      const ok = c.expect ? r.found && !r.unverified && r.citations.some((s) => wanted.includes(s.threadId)) : !r.found;
      if (ok) passed += 1;
      console.log(`${ok ? "PASS" : "FAIL"}  ${usd(r.costUsd)}  ${r.toolCalls} tool calls, ${r.emailsRead} emails${r.limitHit ? `, limit: ${r.limitHit}` : ""}${r.error ? `, error: ${r.error}` : ""}`);
      console.log(`      Q${i + 1}${c.followUp ? " (follow-up)" : ""}: ${c.question}`);
      console.log(`      A: ${r.answerMarkdown.replace(/\s+/g, " ").slice(0, 300)}`);
      console.log(`      expected ${c.expect ? `a citation of "${c.expect}"` : "not found"}; cited: ${r.citations.map((s) => s.subject).join(" | ") || "nothing"}\n`);
    }
    console.log(`${passed}/${CASES.length} passed. Total ${usd(cost)}, average ${usd(cost / CASES.length)} per question.`);
    if (passed < CASES.length) process.exitCode = 1;
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? (process.env.LOG_LEVEL === "debug" ? err.stack : err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
