import { requirePayment } from "./x402.js";
import { okx } from "./config.js";

/*
A reference "scam-check" ASP, bundled with MAILER for the demo.

It behaves exactly like a real third-party security agent on OKX.AI:
it charges via x402 (402 -> pay -> retry) and returns a sender-risk score.
This lets the FULL buyer-side loop run live on testnet/mock without
depending on an external ASP being online.

At go-live, point SCAM_CHECK_ENDPOINT at a real security ASP instead —
MAILER's calling code doesn't change.
*/

const SUSPICIOUS_TLDS = [".xyz", ".top", ".click", ".loan", ".work", ".zip", ".mov"];
const SCAM_PHRASES = [
  "verify your account", "click here", "urgent", "wire transfer", "gift card",
  "bitcoin", "crypto wallet", "suspended", "confirm your password", "act now",
  "you have won", "claim your prize", "unusual activity", "update your billing",
  "limited time", "send payment", "reset your password", "invoice attached",
];

function scoreSender({ fromAddr = "", subject = "", body = "" }) {
  const from = fromAddr.toLowerCase();
  const text = (subject + " " + body).toLowerCase();
  let risk = 0;
  const reasons = [];

  const domain = from.split("@")[1] || "";
  if (SUSPICIOUS_TLDS.some((t) => domain.endsWith(t))) { risk += 0.3; reasons.push("sender domain uses a high-abuse TLD"); }
  if (/\d{4,}/.test(domain)) { risk += 0.15; reasons.push("numeric-heavy domain"); }
  if (/(support|billing|security|admin)@(?!.*(paypal|google|microsoft|apple)\.)/.test(from) && domain.length > 15) {
    risk += 0.1; reasons.push("impersonation-style sender name");
  }

  const hits = SCAM_PHRASES.filter((p) => text.includes(p));
  if (hits.length) { risk += Math.min(0.5, hits.length * 0.18); reasons.push(`scam phrasing: ${hits.slice(0, 3).join(", ")}`); }

  if (/https?:\/\/[^\s]*(bit\.ly|tinyurl|\.xyz|\.top|\.click)/.test(text)) { risk += 0.25; reasons.push("shortened/suspicious link"); }
  if (/attached (invoice|document|file)/.test(text) && hits.length) { risk += 0.1; reasons.push("payment lure with attachment"); }

  risk = Math.min(1, Number(risk.toFixed(2)));
  return { risk, reasons: reasons.length ? reasons : ["no strong signals"] };
}

export function mountMockAsp(app) {
  // priced via x402 at the same rate MAILER is willing to pay
  app.post("/mock-asp/scan", requirePayment(okx.scamCheck.maxPrice, "mock-scam-check"), (req, res) => {
    const { fromAddr, subject, body } = req.body || {};
    const result = scoreSender({ fromAddr, subject, body });
    res.json({
      provider: "reference-scam-check (bundled demo ASP)",
      paidBy: req.payment?.payer,
      txRef: req.payment?.txRef,
      ...result,
    });
  });
  console.log("Mock scam-check ASP mounted at POST /mock-asp/scan (x402-protected).");
}
