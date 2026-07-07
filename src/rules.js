export function computePriority(email, rules) {
  const from = (email.fromAddr || email.from || "").toLowerCase();
  const text = ((email.subject || "") + " " + (email.body || "")).toLowerCase();

  for (const level of ["high", "low"]) {
    for (const r of rules.filter((x) => x.level === level)) {
      const v = (r.value || "").toLowerCase().trim();
      if (!v) continue;
      if (r.type === "sender" && from.includes(v)) return { level, rule: r };
      if (r.type === "domain" && from.includes(v.replace(/^@/, ""))) return { level, rule: r };
      if (r.type === "keyword" && text.includes(v)) return { level, rule: r };
    }
  }
  return { level: "normal", rule: null };
}
