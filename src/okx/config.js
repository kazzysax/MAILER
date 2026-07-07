import { config as base } from "../config.js";

/*
MAILER on OKX.AI — configuration.

Tier 1 (SELLER, live): MAILER exposes services other agents pay to call.
Tier 2 (BUYER, demo/testnet): MAILER hires a scam-check agent via x402.

Everything is driven by env vars so the same code runs against a local
mock counterparty (dev), testnet, or mainnet with no edits.
*/
export const okx = {
  // MAILER's Agentic Wallet — created by you via OnchainOS, address+key pasted into env.
  // The private key signs outbound payments (Tier 2) and proves identity.
  walletAddress: process.env.OKX_WALLET_ADDRESS || "",
  walletKey: process.env.OKX_WALLET_KEY || "", // keep secret; never commit

  // network: "mock" (local, no chain), "testnet", or "mainnet"
  network: process.env.OKX_NETWORK || "mock",

  // x402 settlement token + chain info
  token: process.env.OKX_TOKEN || "USDT",
  chainId: Number(process.env.OKX_CHAIN_ID || 196), // X Layer mainnet = 196

  // real onchain verification (used when network = testnet|mainnet)
  rpcUrl: process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech",
  usdtContract: process.env.USDT_CONTRACT_ADDRESS || "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
  minConfirmations: Number(process.env.MIN_CONFIRMATIONS || 1),

  // ---- Tier 1: prices MAILER charges (in smallest USDT units is overkill for demo; use decimal) ----
  sell: {
    triage: Number(process.env.PRICE_TRIAGE || 0.005),
    draftReply: Number(process.env.PRICE_DRAFT || 0.02),
    fillTemplate: Number(process.env.PRICE_FILL || 0.02),
  },

  // ---- Tier 2: what MAILER will pay to hire a scam-check agent ----
  scamCheck: {
    enabled: (process.env.SCAM_CHECK_ENABLED || "true").toLowerCase() !== "false",
    // endpoint of the scam-check ASP. Defaults to MAILER's own bundled mock.
    endpoint: process.env.SCAM_CHECK_ENDPOINT || `${base.baseUrl}/mock-asp/scan`,
    maxPrice: Number(process.env.SCAM_CHECK_MAX_PRICE || 0.002), // won't pay more than this per call
    dailyCap: Number(process.env.SCAM_CHECK_DAILY_CAP || 1.0),   // hard USDT/day ceiling
  },

  isLive() {
    return !!(this.walletAddress && this.walletKey && this.network !== "mock");
  },
};
