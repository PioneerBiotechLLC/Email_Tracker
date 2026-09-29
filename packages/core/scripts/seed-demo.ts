/**
 * Demo data for the dashboard: a clearly marked demo organization with ~40
 * realistic pharma-trading threads (English + Arabic) in every status.
 *   pnpm db:seed-demo            create / refresh
 *   pnpm db:seed-demo --remove   delete the demo org and everything under it
 */
import { getDb, disconnectDb, protectBody, recomputeThread, normalizeSubject } from "../src/index.js";

const DOMAIN = "demo-pharma.example";
const MAILBOXES = ["sales@demo-pharma.example", "regulatory@demo-pharma.example"];
const ADMIN = "demo-admin@demo-pharma.example";
const VIEWER = "demo-viewer@demo-pharma.example";

// Deterministic PRNG so the demo looks the same every time.
let rngState = 42;
const rnd = () => (rngState = (rngState * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

interface Scenario {
  subject: string;
  category: "customer" | "supplier" | "internal" | "regulatory" | "finance" | "newsletter" | "notification" | "other";
  priority: "low" | "normal" | "high" | "urgent";
  from: { address: string; name: string };
  lang: "en" | "ar" | "mixed";
  /** message texts alternating inbound/outbound starting inbound; "OUT:" prefix marks ours */
  messages: string[];
  summary?: string;
  keyPoints?: string[];
  asks?: { from: string; ask: string; due: string | null }[];
  nextAction?: string | null;
  needsReply?: boolean;
  /** leave unsummarized / with an error */
  summaryState?: "pending" | "error";
  /** how many hours ago the LAST message arrived */
  lastHoursAgo: number;
  /** hours between messages */
  gapHours?: number;
  forceStatus?: "closed" | "no_reply_needed";
  autoReplyLast?: boolean;
}

const customers = [
  { address: "procurement@alnoor-hospital.ae", name: "Al Noor Hospital Procurement" },
  { address: "purchasing@medcare-pharmacies.sa", name: "MedCare Pharmacies" },
  { address: "tenders@moh-supplies.eg", name: "MOH Supplies Tenders" },
  { address: "ahmed.k@gulfmed-distribution.com", name: "Ahmed Khalil" },
  { address: "sara@cityclinic.ae", name: "Sara Haddad" },
];
const suppliers = [
  { address: "export@hetero-labs.in", name: "Hetero Labs Export" },
  { address: "sales@sunpharma-intl.com", name: "Sun Pharma International" },
  { address: "orders@bbraun-me.com", name: "B. Braun Middle East" },
  { address: "logistics@dhl-healthcare.com", name: "DHL Healthcare" },
];

const scenarios: Scenario[] = [
  { subject: "Quotation request – Paracetamol 500mg tablets (200,000 packs)", category: "customer", priority: "high", from: customers[0]!, lang: "en", lastHoursAgo: 30,
    messages: ["Dear Sales,\n\nPlease quote for 200,000 packs of Paracetamol 500mg (10x10 blisters), delivery to Abu Dhabi within 6 weeks. Include COA and shelf life.\n\nRegards,\nProcurement"],
    summary: "Al Noor Hospital asks for a quotation for 200,000 packs of Paracetamol 500mg, delivery to Abu Dhabi within 6 weeks, with COA and shelf life. No reply sent yet.",
    keyPoints: ["200,000 packs Paracetamol 500mg (10x10)", "Delivery Abu Dhabi within 6 weeks", "COA and shelf life required"], asks: [{ from: "Al Noor Procurement", ask: "Send quotation with COA and shelf life", due: null }], nextAction: "Send the quotation with COA and shelf-life details", needsReply: true },
  { subject: "PO 4512 – Amoxicillin 250mg suspension", category: "customer", priority: "normal", from: customers[1]!, lang: "en", lastHoursAgo: 5, gapHours: 20,
    messages: ["Please find attached PO 4512 for 5,000 bottles Amoxicillin 250mg/5ml suspension. Confirm delivery date.", "OUT:Thank you. PO 4512 confirmed; dispatch expected 12 Oct, delivery to Riyadh by 18 Oct. Invoice INV-2210 attached.", "Received, thanks. Please share the tracking number once shipped."],
    summary: "MedCare sent PO 4512 for 5,000 bottles of Amoxicillin 250mg/5ml. We confirmed dispatch on 12 Oct and delivery by 18 Oct (INV-2210). They now ask for the tracking number once shipped.",
    keyPoints: ["PO 4512: 5,000 bottles Amoxicillin 250mg/5ml", "Dispatch 12 Oct, delivery Riyadh 18 Oct", "INV-2210 issued"], asks: [{ from: "MedCare", ask: "Tracking number once shipped", due: "after dispatch" }], nextAction: "Send the tracking number after dispatch on 12 Oct", needsReply: true },
  { subject: "طلب عرض سعر – إنسولين جلارجين 100 وحدة/مل", category: "customer", priority: "urgent", from: customers[3]!, lang: "ar", lastHoursAgo: 60,
    messages: ["السلام عليكم،\n\nنرجو تزويدنا بعرض سعر لكمية ٣٠٠٠ قلم إنسولين جلارجين ١٠٠ وحدة/مل، التسليم خلال أسبوعين إلى دبي. الموضوع عاجل بسبب نفاد المخزون.\n\nمع التحية،\nأحمد خليل"],
    summary: "Ahmed Khalil (GulfMed) urgently requests a quotation for 3,000 insulin glargine 100 U/ml pens, delivery to Dubai within two weeks, because their stock has run out. No reply yet.",
    keyPoints: ["3,000 insulin glargine 100 U/ml pens", "Delivery Dubai within 2 weeks", "Customer is out of stock"], asks: [{ from: "Ahmed Khalil", ask: "Quotation for 3,000 pens", due: "as soon as possible" }], nextAction: "Check cold-chain stock and send a quotation today", needsReply: true },
  { subject: "RE: COA for batch PCM-2309 – Paracetamol 500mg", category: "supplier", priority: "normal", from: suppliers[0]!, lang: "en", lastHoursAgo: 8, gapHours: 30,
    messages: ["OUT:Dear Hetero team, please send the COA for batch PCM-2309 before the shipment leaves Mumbai.", "Please find the COA for batch PCM-2309 attached. Assay 99.6%, dissolution compliant, expiry 08/2028.", "OUT:Received with thanks. Cleared for shipment."],
    summary: "We asked Hetero for the COA of batch PCM-2309; they sent it (assay 99.6%, expiry 08/2028) and we confirmed the batch is cleared for shipment. Nothing pending.",
    keyPoints: ["Batch PCM-2309 COA received", "Assay 99.6%, expiry 08/2028", "Cleared for shipment"], asks: [], nextAction: null, needsReply: false },
  { subject: "Shipment AWB 1234-5678 delayed at Jebel Ali", category: "supplier", priority: "urgent", from: suppliers[3]!, lang: "en", lastHoursAgo: 50,
    messages: ["Shipment AWB 1234-5678 (12 pallets, temperature-controlled) is held at Jebel Ali customs pending the import permit copy. Please send it today to avoid demurrage of AED 1,200/day."],
    summary: "DHL reports that shipment AWB 1234-5678 (12 temperature-controlled pallets) is held at Jebel Ali customs pending the import permit. Demurrage of AED 1,200/day applies until we send the permit copy.",
    keyPoints: ["AWB 1234-5678, 12 pallets, cold chain", "Held at Jebel Ali customs", "Demurrage AED 1,200/day"], asks: [{ from: "DHL Healthcare", ask: "Send the import permit copy", due: "today" }], nextAction: "Send the import permit copy to DHL immediately", needsReply: true },
  { subject: "MOHAP registration – Metformin 850mg (application MR-2026-118)", category: "regulatory", priority: "high", from: { address: "registration@mohap.gov.ae", name: "MOHAP Registration" }, lang: "en", lastHoursAgo: 100, gapHours: 48,
    messages: ["Reference application MR-2026-118: please submit the updated stability data (zone IVb, 12 months) and the GMP certificate within 30 days.", "OUT:Acknowledged. The stability report and GMP certificate will be submitted by 20 Oct.", "Noted. The application is on hold until the documents are received."],
    summary: "MOHAP asks for updated zone IVb 12-month stability data and the GMP certificate for the Metformin 850mg registration (MR-2026-118) within 30 days. We committed to submit by 20 Oct; the application is on hold until then.",
    keyPoints: ["Application MR-2026-118 Metformin 850mg", "Stability data zone IVb 12 months + GMP certificate", "Deadline: 30 days, we promised 20 Oct"], asks: [{ from: "MOHAP", ask: "Stability data and GMP certificate", due: "20 Oct" }], nextAction: "Collect the stability report from the manufacturer and submit by 20 Oct", needsReply: false },
  { subject: "Payment reminder – INV-2188 (USD 48,300) overdue", category: "finance", priority: "high", from: { address: "accounts@sunpharma-intl.com", name: "Sun Pharma Accounts" }, lang: "en", lastHoursAgo: 75,
    messages: ["Invoice INV-2188 for USD 48,300 was due on 15 Sep and remains unpaid. Please arrange the transfer or share the remittance advice."],
    summary: "Sun Pharma reminds us that invoice INV-2188 (USD 48,300, due 15 Sep) is unpaid and asks for the transfer or a remittance advice.",
    keyPoints: ["INV-2188 USD 48,300 due 15 Sep", "Unpaid"], asks: [{ from: "Sun Pharma Accounts", ask: "Pay or send remittance advice", due: null }], nextAction: "Ask finance for the payment status and reply with the remittance advice", needsReply: true },
  { subject: "Weekly market update – MENA pharma pricing", category: "newsletter", priority: "low", from: { address: "news@pharmaintel.com", name: "PharmaIntel" }, lang: "en", lastHoursAgo: 20,
    messages: ["This week: SFDA price reference updates, new tender calendar for Egypt UPA, and cold-chain regulation changes in KSA. Read more on our site."],
    summary: "Newsletter with MENA pharma pricing and tender news. Informational only.", keyPoints: [], asks: [], nextAction: null, needsReply: false, forceStatus: "no_reply_needed" },
  { subject: "Your Microsoft 365 invoice is ready", category: "notification", priority: "low", from: { address: "billing@microsoft.com", name: "Microsoft Billing" }, lang: "en", lastHoursAgo: 40,
    messages: ["Your invoice for September is available in the admin center. No action is required."],
    summary: "Automatic billing notification from Microsoft. No action needed.", keyPoints: [], asks: [], nextAction: null, needsReply: false, forceStatus: "no_reply_needed" },
  { subject: "Tender 2026/117 – Oncology products, technical file", category: "customer", priority: "high", from: customers[2]!, lang: "mixed", lastHoursAgo: 12, gapHours: 72,
    messages: ["نرجو تزويدنا بالملف الفني للمناقصة رقم 2026/117 (منتجات الأورام) قبل 5 أكتوبر.\nPlease also confirm CIF Alexandria pricing in USD.", "OUT:Dear team, the technical file for tender 2026/117 is attached; CIF Alexandria prices in USD are in the annex.", "شكراً، تم الاستلام. سنعود إليكم بعد لجنة الفحص."],
    summary: "MOH Supplies asked for the technical file for oncology tender 2026/117 and CIF Alexandria pricing in USD. We sent both; they confirmed receipt and will come back after the evaluation committee.",
    keyPoints: ["Tender 2026/117 oncology products", "Technical file + CIF Alexandria USD prices sent", "Waiting for their evaluation committee"], asks: [], nextAction: null, needsReply: false },
  { subject: "Internal: stock count Q4 – cold room", category: "internal", priority: "normal", from: { address: "warehouse@demo-pharma.example", name: "Warehouse Team" }, lang: "en", lastHoursAgo: 28,
    messages: ["Cold room stock count is scheduled for Thursday 8:00. Sales team: please freeze insulin allocations until noon."],
    summary: "Warehouse announces the Q4 cold-room stock count on Thursday 8:00 and asks sales to freeze insulin allocations until noon.", keyPoints: ["Stock count Thursday 08:00", "Freeze insulin allocations until noon"], asks: [{ from: "Warehouse", ask: "Freeze insulin allocations until noon Thursday", due: "Thursday" }], nextAction: "Confirm to warehouse and inform the sales team", needsReply: true },
  { subject: "RE: Ceftriaxone 1g vials – price revision from 1 Nov", category: "supplier", priority: "normal", from: suppliers[2]!, lang: "en", lastHoursAgo: 150, gapHours: 24,
    messages: ["Please note our Ceftriaxone 1g vial price changes to USD 0.92 from 1 Nov. Orders placed before 25 Oct keep USD 0.85.", "OUT:Noted. We will place a 50,000-vial order before 25 Oct at USD 0.85.", "Confirmed, thank you. Please send the PO by 20 Oct so we can reserve stock."],
    summary: "B. Braun raises the Ceftriaxone 1g vial price to USD 0.92 from 1 Nov. We said we'd order 50,000 vials before 25 Oct at USD 0.85; they ask for the PO by 20 Oct to reserve stock.",
    keyPoints: ["Price USD 0.85 → 0.92 from 1 Nov", "Planned order: 50,000 vials", "PO needed by 20 Oct"], asks: [{ from: "B. Braun", ask: "Send the PO", due: "20 Oct" }], nextAction: "Issue the 50,000-vial PO before 20 Oct", needsReply: true },
  { subject: "Automatic reply: Out of office", category: "other", priority: "low", from: customers[4]!, lang: "en", lastHoursAgo: 3, autoReplyLast: true, gapHours: 1,
    messages: ["OUT:Hi Sara, the revised quotation for the clinic consumables is attached.", "I am out of the office until 6 Oct with limited access to email."],
    summary: "We sent Sara the revised consumables quotation; her out-of-office auto-reply says she is back on 6 Oct.", keyPoints: ["Revised quotation sent", "Sara back 6 Oct"], asks: [], nextAction: "Follow up with Sara after 6 Oct", needsReply: false },
  { subject: "Thank you – delivery received", category: "customer", priority: "low", from: customers[1]!, lang: "en", lastHoursAgo: 200, gapHours: 30,
    messages: ["OUT:Your order PO 4490 was delivered today. Please confirm receipt.", "Received in good condition, thank you for the fast delivery."],
    summary: "PO 4490 was delivered and MedCare confirmed receipt in good condition. Conversation concluded.", keyPoints: ["PO 4490 delivered and confirmed"], asks: [], nextAction: null, needsReply: false, forceStatus: "closed" },
  { subject: "Import permit renewal – controlled substances list 2027", category: "regulatory", priority: "normal", from: { address: "permits@mohap.gov.ae", name: "MOHAP Permits" }, lang: "en", lastHoursAgo: 15, summaryState: "pending",
    messages: ["The annual import permit for controlled substances expires on 31 Dec. Submit the 2027 quantities forecast through the portal by 15 Nov."] },
  { subject: "Quotation Q-2291 follow-up", category: "customer", priority: "normal", from: customers[3]!, lang: "en", lastHoursAgo: 2, summaryState: "error",
    messages: ["Any update on quotation Q-2291? Our tender closes Sunday."] },
];

// Generate extra variations to reach ~40 threads
const extraSubjects = [
  ["Proforma invoice PI-77 – Omeprazole 20mg capsules", "customer", "normal", "en"],
  ["استفسار عن توفر أكياس محلول ملحي ٠.٩٪ ٥٠٠ مل", "customer", "high", "ar"],
  ["Cold chain excursion report – shipment CC-0921", "supplier", "urgent", "en"],
  ["SFDA – GMP inspection schedule for manufacturer site", "regulatory", "high", "en"],
  ["LC draft for PO 4530 – bank comments", "finance", "normal", "en"],
  ["Sample request – Atorvastatin 40mg (registration samples)", "supplier", "normal", "en"],
  ["Tender award notice – 2026/102 antibiotics", "customer", "urgent", "mixed"],
  ["Price list update Q4 – consumables", "customer", "low", "en"],
  ["Damaged cartons on delivery – DN 8812", "customer", "high", "en"],
  ["Registration certificate expiry – Losartan 50mg (Egypt)", "regulatory", "high", "en"],
  ["Credit note CN-104 for short shipment", "finance", "normal", "en"],
  ["طلب شهادة تحليل – دفعة AMX-2301", "supplier", "normal", "ar"],
  ["Tender 2026/130 – bid bond extension", "customer", "high", "en"],
  ["Freight quotation Mumbai → Jebel Ali (reefer, 2 pallets)", "supplier", "normal", "en"],
  ["Monthly sales report – September", "internal", "low", "en"],
  ["New product enquiry – Vitamin D3 50,000 IU", "customer", "normal", "en"],
  ["Recall notice – batch LSR-1107 Losartan 50mg", "regulatory", "urgent", "en"],
  ["Warehouse temperature logger alarm", "notification", "normal", "en"],
  ["Payment received – INV-2201", "finance", "low", "en"],
  ["Re: Meeting request – annual supply agreement", "supplier", "normal", "en"],
  ["Complaint: late delivery PO 4501", "customer", "high", "en"],
  ["Customs HS code clarification – dressings", "supplier", "normal", "en"],
  ["استعلام عن حالة الطلب رقم PO 4520", "customer", "normal", "ar"],
  ["Contract renewal – distribution agreement KSA", "customer", "high", "en"],
] as const;

const bodies: Record<string, string[]> = {
  en: ["Please advise on the above at your earliest convenience.", "Could you confirm the timeline and pricing for this?", "We need this resolved before the end of the week.", "Attached are the documents for your review.", "Kindly confirm receipt and next steps."],
  ar: ["نرجو الإفادة في أقرب وقت ممكن.", "هل يمكنكم تأكيد الموعد والسعر؟", "نحتاج إلى حل هذا الموضوع قبل نهاية الأسبوع.", "مرفق المستندات للمراجعة."],
  mixed: ["نرجو التأكيد. Please confirm by Thursday.", "Attached the file كما هو مطلوب."],
};
const oursReplies = ["Thank you for your email. We will revert with details shortly.", "Confirmed. Please see the attached document.", "Noted with thanks; our team is working on it and will update you tomorrow."];

for (let i = 0; i < extraSubjects.length; i++) {
  const [subject, category, priority, lang] = extraSubjects[i]!;
  const from = category === "supplier" ? pick(suppliers) : category === "regulatory" ? { address: "info@sfda.gov.sa", name: "SFDA" } : category === "internal" ? { address: "finance@demo-pharma.example", name: "Finance" } : pick(customers);
  const n = 1 + Math.floor(rnd() * 4);
  const messages: string[] = [];
  for (let k = 0; k < n; k++) messages.push(k % 2 === 1 ? `OUT:${pick(oursReplies)}` : pick(bodies[lang]!)!);
  const summarize = rnd() > 0.15;
  scenarios.push({
    subject, category, priority, from, lang, messages,
    lastHoursAgo: 4 + Math.floor(rnd() * 900), gapHours: 6 + Math.floor(rnd() * 40),
    ...(summarize ? { summary: `${from.name} wrote about "${subject}". ${n > 1 ? "We replied and the conversation continued." : "No reply from our side yet."}`, keyPoints: [subject], asks: n % 2 ? [{ from: from.name, ask: "Confirmation / reply", due: null }] : [], nextAction: n % 2 ? "Reply with the requested confirmation" : null, needsReply: n % 2 === 1 } : { summaryState: "pending" as const }),
    ...(rnd() > 0.85 ? { forceStatus: "closed" as const } : {}),
  });
}

async function remove() {
  const db = getDb();
  const r = await db.organization.deleteMany({ where: { domain: DOMAIN } });
  console.log(r.count ? `Removed demo organization ${DOMAIN} (and all its mailboxes, threads, messages, users, usage, audit logs).` : "No demo organization found.");
}

async function seed() {
  const db = getDb();
  await db.organization.deleteMany({ where: { domain: DOMAIN } });
  const org = await db.organization.create({ data: { name: "Demo Pharma (DEMO DATA)", domain: DOMAIN, azureTenantId: "00000000-0000-0000-0000-000000000000", isDemo: true, digestRecipients: [ADMIN] } });
  const mbs = [];
  for (const email of MAILBOXES) mbs.push(await db.mailbox.create({ data: { orgId: org.id, emailAddress: email, displayName: email.split("@")[0]!.replace(/^\w/, (c) => c.toUpperCase()), graphUserId: `demo-${email}`, lastSyncedAt: hoursAgo(1) } }));
  await db.appUser.createMany({ data: [{ orgId: org.id, email: ADMIN, name: "Demo Admin", role: "admin" }, { orgId: org.id, email: VIEWER, name: "Demo Viewer", role: "viewer" }] });

  let n = 0;
  for (const sc of scenarios) {
    const mb = sc.category === "regulatory" ? mbs[1]! : mbs[0]!;
    const conversationId = `demo-conv-${++n}`;
    const gap = sc.gapHours ?? 24;
    const count = sc.messages.length;
    const thread = await db.thread.create({ data: { mailboxId: mb.id, conversationId, subject: sc.subject, normalizedSubject: normalizeSubject(sc.subject), firstMessageAt: new Date(), lastMessageAt: new Date() } });
    let prevInboundId: string | null = null;
    let prevInboundMsgId: string | null = null;
    for (let k = 0; k < count; k++) {
      const raw = sc.messages[k]!;
      const ours = raw.startsWith("OUT:");
      const text = ours ? raw.slice(4) : raw;
      const at = hoursAgo(sc.lastHoursAgo + (count - 1 - k) * gap);
      const isAuto = !!sc.autoReplyLast && k === count - 1;
      const stored = protectBody(text);
      const internetMessageId = `<${conversationId}-${k}@demo>`;
      const m = await db.message.create({
        data: {
          mailboxId: mb.id, threadId: thread.id, conversationId, graphMessageId: `${conversationId}-${k}`, internetMessageId,
          inReplyTo: ours && prevInboundMsgId ? prevInboundMsgId : null, references: ours && prevInboundMsgId ? [prevInboundMsgId] : [],
          direction: ours ? "outbound" : "inbound", folder: ours ? "sent" : "inbox",
          fromAddress: ours ? mb.emailAddress : sc.from.address, fromName: ours ? mb.displayName : sc.from.name,
          toAddresses: ours ? [{ address: sc.from.address, name: sc.from.name }] : [{ address: mb.emailAddress, name: mb.displayName }],
          subject: k === 0 ? sc.subject : `RE: ${sc.subject}`, receivedAt: at, sentAt: at, bodyPreview: text.slice(0, 120),
          bodyText: stored.bodyText, bodyEncrypted: stored.bodyEncrypted, isAutoReply: isAuto,
          // some inbound messages carry the Outlook reply verb instead of a matched sent copy
          ...(!ours && k + 1 < count && sc.messages[k + 1]!.startsWith("OUT:") && rnd() > 0.5 ? { lastVerb: 102, lastVerbAt: hoursAgo(sc.lastHoursAgo + (count - 2 - k) * gap) } : {}),
        },
      });
      if (!ours) { prevInboundId = m.id; prevInboundMsgId = internetMessageId; }
    }
    void prevInboundId;
    await recomputeThread(db, mb.id, conversationId);
    const data: Record<string, unknown> = { category: sc.category, priority: sc.priority };
    if (sc.summaryState === "error") data.summaryError = `${new Date().toISOString()} invalid_output: category: Invalid option`;
    else if (sc.summaryState !== "pending" && sc.summary) {
      Object.assign(data, { summary: sc.summary, keyPoints: sc.keyPoints ?? [], asks: sc.asks ?? [], nextAction: sc.nextAction ?? null, summaryLang: sc.lang, summaryUpdatedAt: hoursAgo(sc.lastHoursAgo - 0.1), summaryMessageCount: count, summaryModel: "demo", needsReply: sc.needsReply ?? true, needsReplyDecidedBy: "ai", needsReplyDecidedAt: hoursAgo(sc.lastHoursAgo - 0.1) });
    }
    await db.thread.update({ where: { id: thread.id }, data });
    await recomputeThread(db, mb.id, conversationId);
    if (sc.forceStatus === "closed") await db.thread.update({ where: { id: thread.id }, data: { status: "closed", closedAt: hoursAgo(sc.lastHoursAgo - 1), closedBy: sc.needsReply === false ? "ai" : ADMIN, awaitingSince: null, overdueAt: null } });
    if (sc.forceStatus === "no_reply_needed") await db.thread.update({ where: { id: thread.id }, data: { status: "no_reply_needed", needsReply: false, needsReplyDecidedBy: "ai", needsReplyDecidedAt: hoursAgo(sc.lastHoursAgo - 0.1), awaitingSince: null, overdueAt: null } });
  }
  // A little AI usage history for the settings page
  const usage = [];
  for (let d = 0; d < 14; d++) for (let c = 0; c < 3 + Math.floor(rnd() * 6); c++) usage.push({ orgId: org.id, model: rnd() > 0.3 ? "claude-sonnet-5-5" : "claude-haiku-4-5", inputTokens: 900 + Math.floor(rnd() * 2000), outputTokens: 250 + Math.floor(rnd() * 300), cacheReadTokens: 900, cacheWriteTokens: 0, costUsd: 0.004 + rnd() * 0.006, batch: rnd() > 0.5, createdAt: hoursAgo(d * 24 + rnd() * 20) });
  await db.aiUsage.createMany({ data: usage });

  const counts = await db.thread.groupBy({ by: ["status"], where: { mailbox: { orgId: org.id } }, _count: true });
  console.log(`Seeded demo organization "${org.name}" (${DOMAIN}) with ${scenarios.length} threads:`);
  for (const c of counts) console.log(`  ${c.status.padEnd(16)} ${c._count}`);
  console.log(`Dashboard users: ${ADMIN} (admin), ${VIEWER} (viewer). Remove everything with: pnpm db:seed-demo --remove`);
}

try {
  if (process.argv.includes("--remove")) await remove();
  else await seed();
} finally {
  await disconnectDb();
}
