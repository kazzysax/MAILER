import { requirePayment } from "./x402.js";
import { okx } from "./config.js";
import { analyzeEmail, draftReply, fillTemplate } from "../ai.js";

/*
Tier 1 — MAILER as a SELLER on OKX.AI.

Three services other agents pay to call, each x402-priced. These wrap
MAILER's existing intelligence so any agent on the marketplace can use
MAILER's inbox brain as a paid micro-service.

Registered on OKX.AI as an A2MCP ASP. Every successful call = onchain
income to MAILER's Agentic Wallet.
*/

let earned = 0;
let calls = 0;
export function earnings() {
  return { earned: Number(earned.toFixed(6)), calls, token: okx.token };
}
function record(amount) {
  earned += amount;
  calls += 1;
}

export function mountServices(app) {
  // ---- mailer.triage : prioritize + summarize + extract action ----
  app.post("/asp/triage", requirePayment(okx.sell.triage, "mailer.triage"), async (req, res) => {
    const { from, fromAddr, subject, body, attachments } = req.body || {};
    if (!subject && !body) return res.status(400).json({ error: "subject or body required" });
    try {
      const a = await analyzeEmail({ from: from || fromAddr || "", subject: subject || "", body: body || "", attachments: attachments || [] });
      record(okx.sell.triage);
      res.json({ service: "mailer.triage", price: okx.sell.triage, paidBy: req.payment?.payer, txRef: req.payment?.txRef, result: a });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- mailer.draft_reply : draft a reply in a requested tone/format ----
  app.post("/asp/draft_reply", requirePayment(okx.sell.draftReply, "mailer.draft_reply"), async (req, res) => {
    const { from, subject, body, instruction } = req.body || {};
    if (!instruction) return res.status(400).json({ error: "instruction required" });
    try {
      const draft = await draftReply({ from: from || "", subject: subject || "", body: body || "" }, instruction);
      record(okx.sell.draftReply);
      res.json({ service: "mailer.draft_reply", price: okx.sell.draftReply, paidBy: req.payment?.payer, txRef: req.payment?.txRef, result: { draft } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- mailer.fill_template : fill a placeholder template from an email ----
  app.post("/asp/fill_template", requirePayment(okx.sell.fillTemplate, "mailer.fill_template"), async (req, res) => {
    const { from, subject, body, template } = req.body || {};
    if (!template) return res.status(400).json({ error: "template required" });
    try {
      const filled = await fillTemplate({ from: from || "", subject: subject || "", body: body || "" }, { content: template });
      record(okx.sell.fillTemplate);
      res.json({ service: "mailer.fill_template", price: okx.sell.fillTemplate, paidBy: req.payment?.payer, txRef: req.payment?.txRef, result: { filled } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- public service manifest (what OKX.AI lists) ----
  app.get("/asp/manifest", (req, res) => {
    res.json({
      name: "MAILER",
      tagline: "Never miss an email. Inbox triage, reply drafting and template filling as paid agent services.",
      wallet: okx.walletAddress || "(not set — create Agentic Wallet)",
      network: okx.network,
      token: okx.token,
      services: [
        { name: "mailer.triage", price: okx.sell.triage, endpoint: "/asp/triage",
          input: "{ from, subject, body, attachments[] }", output: "{ priority, summary, action }" },
        { name: "mailer.draft_reply", price: okx.sell.draftReply, endpoint: "/asp/draft_reply",
          input: "{ from, subject, body, instruction }", output: "{ draft }" },
        { name: "mailer.fill_template", price: okx.sell.fillTemplate, endpoint: "/asp/fill_template",
          input: "{ from, subject, body, template }", output: "{ filled }" },
      ],
    });
  });

  console.log("MAILER ASP services mounted: /asp/triage /asp/draft_reply /asp/fill_template (x402-protected).");
}
