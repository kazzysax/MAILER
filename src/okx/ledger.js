import { okx } from "./config.js";

/*
Spend cap: MAILER will never pay out more than dailyCap USDT/day hiring
other agents. A safety net so a bug or abuse can't drain the wallet.
Resets at UTC midnight. In-memory is fine (resets on restart = safer, not riskier).
*/
let day = today();
let spent = 0;

function today() {
  return new Date().toISOString().slice(0, 10);
}
function roll() {
  const t = today();
  if (t !== day) {
    day = t;
    spent = 0;
  }
}

export function spend(amount) {
  roll();
  if (spent + amount > okx.scamCheck.dailyCap) {
    throw new Error(`Daily spend cap reached (${okx.scamCheck.dailyCap} ${okx.token}). Skipping paid call.`);
  }
  spent += amount;
}

export function spentToday() {
  roll();
  return { spent: Number(spent.toFixed(6)), cap: okx.scamCheck.dailyCap, token: okx.token, day };
}
