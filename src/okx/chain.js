import { okx } from "./config.js";

/*
Mainnet-grade payment verification for Tier 1 (MAILER as seller).

No web3 library needed — we speak raw JSON-RPC to X Layer and decode the
standard ERC-20 Transfer(address,address,uint256) event ourselves. This is
the same event every USDT/USDC transfer emits on any EVM chain.

Proof of payment from a buyer is simply a transaction hash. We don't trust
the buyer's word — we read the chain and confirm:
  1. the tx exists and succeeded
  2. it has enough confirmations to not be reorg-able
  3. it emits a Transfer event on the USDT contract
  4. the recipient is MAILER's wallet
  5. the amount is at least what was quoted
Each verified tx hash can only be used once (enforced by the caller via
the used_payments table), so a single payment can't be replayed across
multiple paid calls.
*/

// keccak256("Transfer(address,address,uint256)") — standard ERC-20 event topic
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

let cachedDecimals = null;

async function rpc(method, params, timeoutMs = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(okx.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`RPC error: ${data.error.message || JSON.stringify(data.error)}`);
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

export async function getTokenDecimals() {
  if (cachedDecimals != null) return cachedDecimals;
  // eth_call decimals() = selector 0x313ce567
  const result = await rpc("eth_call", [{ to: okx.usdtContract, data: "0x313ce567" }, "latest"]);
  cachedDecimals = parseInt(result, 16);
  return cachedDecimals;
}

export async function currentBlock() {
  const hex = await rpc("eth_blockNumber", []);
  return parseInt(hex, 16);
}

/** Convert a decimal amount like 0.02 into the token's smallest integer units, precisely (no float error). */
function toBaseUnits(amountFloat, decimals) {
  const s = String(amountFloat);
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

function padAddress(addr) {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function addressFromTopic(topic) {
  return "0x" + topic.slice(-40);
}

/**
 * Verify a real onchain USDT payment.
 * @param {string} txHash
 * @param {string} expectedTo - MAILER's wallet address
 * @param {number} minAmountFloat - minimum amount required, e.g. 0.02
 * @returns {Promise<{ok:true, from:string, value:string, decimals:number, blockNumber:number}>}
 * @throws on any verification failure — caller should treat as payment invalid
 */
export async function verifyUsdtPayment(txHash, expectedTo, minAmountFloat) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) throw new Error("Malformed transaction hash");

  const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error("Transaction not found — not yet mined, or wrong network");
  if (receipt.status !== "0x1") throw new Error("Transaction failed onchain");

  if (okx.minConfirmations > 1) {
    const [head, txBlock] = await Promise.all([currentBlock(), Promise.resolve(parseInt(receipt.blockNumber, 16))]);
    const confirmations = head - txBlock + 1;
    if (confirmations < okx.minConfirmations) {
      throw new Error(`Only ${confirmations} confirmation(s), need ${okx.minConfirmations} — try again shortly`);
    }
  }

  const decimals = await getTokenDecimals();
  const minUnits = toBaseUnits(minAmountFloat, decimals);
  const contract = okx.usdtContract.toLowerCase();
  const toPadded = padAddress(expectedTo);

  for (const log of receipt.logs || []) {
    if ((log.address || "").toLowerCase() !== contract) continue;
    if (!log.topics || (log.topics[0] || "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if ((log.topics[2] || "").toLowerCase() !== toPadded) continue;

    const value = BigInt(log.data);
    if (value >= minUnits) {
      return {
        ok: true,
        from: addressFromTopic(log.topics[1]),
        value: value.toString(),
        decimals,
        blockNumber: parseInt(receipt.blockNumber, 16),
      };
    }
  }
  throw new Error("No matching USDT transfer to MAILER's wallet found in this transaction (wrong recipient, token, or amount too low)");
}
