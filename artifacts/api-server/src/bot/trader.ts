import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  formatEther,
  formatUnits,
  maxUint256,
  type Address,
} from "viem";
import { getLiFiQuote, ensureApproval, ETH_ADDRESS } from "../lib/lifi";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { db, tradesTable, creatorsTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { botState } from "./state";
import { broadcast } from "./ws";
import { loadConfig } from "../lib/config";

// ── ERC20 ABI — balanceOf + allowance + approve ───────────────────────────
const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// Zora Quote API endpoint
const ZORA_QUOTE_API = "https://api-sdk.zora.engineering";

// Permit2 universal contract address (same on all EVM chains)
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

// ── Zora API key rotator ─────────────────────────────────────────────────────
// Supports multiple keys via ZORA_API_KEYS (comma-separated).
// Falls back to ZORA_API_KEY for backward compatibility.
// Uses round-robin so concurrent calls spread load across keys.
const ZORA_API_KEYS: string[] = (() => {
  const multi = process.env.ZORA_API_KEYS;
  if (multi) return multi.split(',').map((k) => k.trim()).filter(Boolean);
  const single = process.env.ZORA_API_KEY;
  return single ? [single] : [];
})();
let _zoraKeyIdx = 0;
function nextZoraKey(): string | undefined {
  if (ZORA_API_KEYS.length === 0) return undefined;
  const key = ZORA_API_KEYS[_zoraKeyIdx % ZORA_API_KEYS.length];
  _zoraKeyIdx = (_zoraKeyIdx + 1) % ZORA_API_KEYS.length;
  return key;
}

// Small probe amount for price estimation (never actually sent)
const PROBE_ETH_WEI = parseEther("0.001");

export interface TradeParams {
  tokenAddress: Address;
  tokenName: string;
  tokenSymbol: string;
  creatorAddress: string;
  buyAmountEth: string;
  slippagePercent: number;
  maxGasGwei: number;
  /** The factory event that triggered this snipe (kept for logging). */
  eventName: string;
  /**
   * TP/SL from global config captured at buy time.
   * Stored in the trade row and handed to the Zora-based sniper monitor.
   */
  takeProfitPercent?: number | null;
  stopLossPercent?: number | null;
}

interface ZoraCall {
  target: string;
  data: string;
  value: string;
}

interface ZoraPermit {
  permit: {
    details: {
      token: string;
      amount: string;
      expiration: number;
      nonce: number;
    };
    spender: string;
    sigDeadline: string;
  };
  /** Placeholder string returned by Zora API — must be replaced with actual EIP-712 sig. */
  signature: string;
}

interface ZoraQuoteResult {
  call: ZoraCall;
  permits: ZoraPermit[];
}

/**
 * Injects a signed Permit2 signature into Zora API calldata.
 *
 * The Zora API returns sell calldata with a literal ASCII placeholder
 * "REPLACE_WITH_PERMIT_SIGNATURE_1" where the 65-byte EIP-712 signature
 * must be inserted.  The slot is always exactly 128 bytes (256 hex chars):
 *   - 32 bytes = inner length prefix (0x41 = 65) — ABI-encodes the bytes value
 *   - 65 bytes = signature data
 *   - 31 bytes = zero-padding to next 32-byte boundary
 *   Total: 128 bytes = 256 hex chars
 *
 * The outer ABI length word (immediately before the placeholder) is set to
 * 0x80 = 128 by the Zora API, meaning the bytes field carries 128 bytes of data —
 * the inner ABI-encoding of the 65-byte signature.
 *
 * IMPORTANT: the 256-char slot is NOT all zeros after the placeholder.
 * Words 3–4 of the slot may contain non-zero bytes (e.g. 0x60 offset and
 * token address from other encoding layers).  The slot must be replaced in
 * full using a fixed offset, NOT with a while-zero-skip loop.
 */
function injectPermitSignature(callDataHex: string, signature: `0x${string}`): string {
  const PLACEHOLDER = "REPLACE_WITH_PERMIT_SIGNATURE_1";
  const idx = callDataHex.indexOf(PLACEHOLDER);
  if (idx === -1) {
    throw new Error("injectPermitSignature: placeholder not found in calldata — API response format may have changed");
  }
  const sigHex = signature.slice(2); // 130 hex chars (65 bytes)
  if (sigHex.length !== 130) {
    throw new Error(`injectPermitSignature: unexpected signature length ${sigHex.length} (expected 130 hex chars)`);
  }

  // The full ABI-encoded slot is always 128 bytes = 256 hex chars:
  //   64 chars (32 bytes) = inner length prefix 0x41 = 65
  //   130 chars (65 bytes) = ECDSA signature
  //   62 chars (31 bytes) = zero-padding to 32-byte boundary
  const lengthPrefix = "0000000000000000000000000000000000000000000000000000000000000041"; // 64 chars
  const zeroPad = "0".repeat(62); // 31 bytes padding → 62 chars
  const encodedSig = lengthPrefix + sigHex + zeroPad; // 256 chars total

  // The slot occupies exactly SLOT_CHARS = 256 hex chars starting at idx.
  // We must NOT use a while-zero-skip loop: the last two 32-byte words of the
  // slot contain non-zero bytes (0x60 offset pointer and the token address from
  // the inner encoding), so a zero-skip would stop far too early and GROW the
  // calldata by 33 bytes — corrupting every ABI offset that follows.
  const SLOT_CHARS = 256;
  const slotEnd = idx + SLOT_CHARS;

  if (slotEnd > callDataHex.length) {
    throw new Error(
      `injectPermitSignature: slot extends beyond calldata end ` +
      `(idx=${idx}, slotEnd=${slotEnd}, len=${callDataHex.length})`,
    );
  }

  return callDataHex.slice(0, idx) + encodedSig + callDataHex.slice(slotEnd);
}

/**
 * Ensure a hex string is valid and has the 0x prefix.
 * Zora API sometimes omits the prefix, and may include whitespace/newlines
 * in the JSON response. Throws immediately if the result is not valid hex —
 * better to fail fast than to send malformed calldata and get
 * "Invalid byte sequence" from the Base RPC.
 */
function toHex(s: string): `0x${string}` {
  if (!s) return "0x";
  // Strip whitespace / newlines that can appear in Zora API JSON responses
  const stripped = s.trim().replace(/[\s\r\n]/g, "");
  const clean = stripped.startsWith("0x") ? stripped : `0x${stripped}`;
  if (!/^0x[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(
      `toHex: invalid hex from Zora API (first 80 chars): ${clean.slice(0, 80)}`,
    );
  }
  return clean as `0x${string}`;
}

/** Safely parse a bigint from a string that may be null/undefined/empty. */
function toBigIntSafe(s: string | null | undefined, fallback = 0n): bigint {
  if (!s || s === "") return fallback;
  try { return BigInt(s); } catch { return fallback; }
}

function getRpcUrl(): string {
  const url = process.env.ALCHEMY_RPC_URL;
  if (!url) throw new Error("ALCHEMY_RPC_URL is not set");
  return url;
}

/**
 * ALCHEMY_RPC_URL is typically wss:// (needed by sniper.ts for WebSocket).
 * HTTP clients must use https:// — convert the scheme.
 */
function getHttpRpcUrl(): string {
  return getRpcUrl()
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://");
}

function getWalletKey(): `0x${string}` {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) throw new Error("WALLET_PRIVATE_KEY is not set");
  return key.startsWith("0x") ? (key as `0x${string}`) : `0x${key}`;
}

// ── Zora Quote API helpers ────────────────────────────────────────────────

/**
 * Fetch a BUY quote from Zora Quote API (ETH → erc20).
 * Retries up to 3 times with a 5-second delay — Zora pools need a few blocks
 * after deployment before they are ready to quote.
 */
async function fetchZoraQuote(params: {
  tokenAddress: string;
  buyAmountWei: bigint;
  slippage: number; // fractional, e.g. 0.05 for 5%
  sender: string;
}): Promise<ZoraCall> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const _apiKey = nextZoraKey();
  if (_apiKey) headers["x-api-key"] = _apiKey;

  const body = JSON.stringify({
    chainId: base.id,
    tokenIn: { type: "eth" },
    tokenOut: { type: "erc20", address: params.tokenAddress.toLowerCase() },
    amountIn: params.buyAmountWei.toString(),
    slippage: params.slippage,
    sender: params.sender.toLowerCase(),
    recipient: params.sender.toLowerCase(),
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${ZORA_QUOTE_API}/quote`, {
      method: "POST",
      headers,
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const isPoolNotReady =
        text.includes("Cannot read properties of null") ||
        text.includes("UNKNOWN") ||
        res.status === 400;

      if (isPoolNotReady && attempt < 3) {
        logger.warn(
          { attempt, status: res.status, body: text.slice(0, 100) },
          `Zora quote attempt ${attempt}/3 — pool not ready yet, retry in 5s`,
        );
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      throw new Error(`Zora quote HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!data.call) {
      if (attempt < 3) {
        logger.warn({ attempt, data }, `Zora quote attempt ${attempt}/3 — no call field, retry in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw new Error(`Zora quote returned no call: ${JSON.stringify(data).slice(0, 200)}`);
    }

    logger.info({ attempt, target: data.call.target }, "Zora buy quote OK");
    return data.call as ZoraCall;
  }

  throw new Error("Zora quote failed after 3 attempts — pool not ready or token invalid");
}

/** USDC address on Base — primary sell currency (more reliable routing than ETH for Zora content coins). */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const USDC_DECIMALS = 6;



/**
 * Generic Zora Quote API caller.
 * tokenIn / tokenOut each follow the Zora API shape:
 *   { type: "eth" } or { type: "erc20", address: "0x..." }
 *
 * permitActiveSeconds: how long the Permit2 signature should stay valid.
 * Defaults to 300 (5 min) — enough for approval + signing + submission.
 * Passing 0 lets the API use its own default (often very short, which
 * causes "execution reverted" during gas estimation if there's any delay).
 *
 * signatures: optional array of pre-signed Permit2 permits.  When provided
 * the API embeds the signatures directly into the returned calldata, so
 * injectPermitSignature() is NOT needed.  Pass after the initial quote
 * round has been signed.
 */
async function fetchZoraQuoteGeneric(params: {
  tokenIn: { type: "eth" } | { type: "erc20"; address: string };
  tokenOut: { type: "eth" } | { type: "erc20"; address: string };
  amountIn: bigint;
  slippage: number; // fractional, e.g. 0.05
  sender: string;
  label?: string; // log label
  permitActiveSeconds?: number;
  signatures?: Array<{ permit: ZoraPermit["permit"]; signature: string }>;
}): Promise<ZoraQuoteResult> {
  const {
    tokenIn,
    tokenOut,
    amountIn,
    slippage,
    sender,
    label = "Zora quote",
    permitActiveSeconds = 300,
    signatures,
  } = params;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const _apiKey = nextZoraKey();
  if (_apiKey) headers["x-api-key"] = _apiKey;

  const body = JSON.stringify({
    chainId: base.id,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    slippage,
    sender: sender.toLowerCase(),
    recipient: sender.toLowerCase(),
    permitActiveSeconds,
    ...(signatures && signatures.length > 0 ? { signatures } : {}),
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${ZORA_QUOTE_API}/quote`, { method: "POST", headers, body });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Detect "SwapError: Failed to get quote" — no point retrying, surface immediately
      const isNoRoute =
        text.includes("SwapError") ||
        text.includes("Failed to get quote") ||
        (res.status === 400 && text.includes("UNKNOWN"));
      if (isNoRoute) {
        throw new Error(`ZoraNoRoute: ${text.slice(0, 200)}`);
      }
      if (attempt < 3) {
        logger.warn({ attempt, status: res.status, body: text.slice(0, 100) }, `${label} attempt ${attempt}/3 failed, retry in 5s`);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!data.call) {
      // API may return success as a string "true"/"false" or as a boolean.
      if (data.success === false || data.success === "false" || data.error) {
        // API returned 200 but with an error payload — treat as no-route
        throw new Error(`ZoraNoRoute: ${JSON.stringify(data).slice(0, 200)}`);
      }
      if (attempt < 3) {
        logger.warn({ attempt, data }, `${label} attempt ${attempt}/3 — no call, retry in 5s`);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      throw new Error(`${label} returned no call: ${JSON.stringify(data).slice(0, 200)}`);
    }

    // Guard: if amountOut is "0" the route exists but has no liquidity (common for
    // tokens whose pool pairs against a creator coin rather than WETH/USDC).
    // Throw ZoraNoRoute so the caller falls back to Uniswap V4 or Li.Fi.
    const amountOut: string | null = data.quote?.amountOut ?? null;
    if (amountOut === "0") {
      logger.warn({ attempt, label, amountOut }, `${label}: amountOut is 0 — no liquidity on this route, treating as ZoraNoRoute`);
      throw new Error(`ZoraNoRoute: amountOut is 0 (pool has no liquidity for this route)`);
    }

    const permits: ZoraPermit[] = Array.isArray(data.permits) ? data.permits : [];
    logger.info({ attempt, target: data.call.target, permitsCount: permits.length, amountOut }, `${label} OK`);
    return { call: data.call as ZoraCall, permits };
  }

  throw new Error(`${label} failed after 3 attempts`);
}

/**
 * Fetch a SELL quote from Zora Quote API (erc20 → USDC).
 * USDC routing is more reliable than ETH for Zora content coins whose pools
 * pair against a creator coin rather than WETH directly.
 * Throws ZoraNoRoute error (message starts with "ZoraNoRoute:") if the Zora API
 * cannot find a route — the caller can then attempt a two-step sell.
 *
 * Returns both the calldata and the permits array. When permits are non-empty,
 * the calldata contains the placeholder "REPLACE_WITH_PERMIT_SIGNATURE_1" that
 * must be replaced with the signed Permit2 EIP-712 signature before submission.
 */
async function fetchZoraSellQuote(params: {
  tokenAddress: string;
  tokenAmountWei: bigint;
  slippage: number; // fractional
  sender: string;
}): Promise<ZoraQuoteResult> {
  return fetchZoraQuoteGeneric({
    tokenIn: { type: "erc20", address: params.tokenAddress.toLowerCase() },
    tokenOut: { type: "erc20", address: USDC_BASE.toLowerCase() },
    amountIn: params.tokenAmountWei,
    slippage: params.slippage,
    sender: params.sender,
    label: "Zora sell quote (→USDC)",
  });
}

/**
 * Execute a single Zora swap transaction: approve spender → simulate (warn-only)
 * → estimate gas → send tx → wait for receipt.
 * Returns the tx hash on success, throws on failure.
 */
async function executeZoraSwapTx(params: {
  call: ZoraCall;
  tokenInAddress: Address | null; // null for native ETH swaps (no approval needed)
  tokenInAmount: bigint;
  maxGasGwei: number;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  logCtx: Record<string, unknown>;
}): Promise<`0x${string}`> {
  const { call, tokenInAddress, tokenInAmount, maxGasGwei, publicClient, walletClient, account, logCtx } = params;
  const routerAddress = toHex(call.target) as Address;

  // Approve if selling an ERC20
  if (tokenInAddress) {
    const allowance = await publicClient.readContract({
      address: tokenInAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, routerAddress],
    });
    if (allowance < tokenInAmount) {
      logger.info({ ...logCtx, spender: call.target }, "Approving Zora router");
      const approveTx = await walletClient.writeContract({
        address: tokenInAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [routerAddress, maxUint256],
        chain: base,
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
      logger.info({ ...logCtx, approveTx }, "Approval confirmed");
    }
  }

  // Simulate (warning-only — Zora router often reverts in eth_call)
  let simFailed = false;
  try {
    await publicClient.call({
      to: routerAddress,
      data: toHex(call.data),
      value: toBigIntSafe(call.value),
      account: account.address,
    });
    logger.info(logCtx, "Swap simulation passed");
  } catch (simErr) {
    simFailed = true;
    const msg = simErr instanceof Error ? simErr.message.slice(0, 200) : String(simErr);
    logger.warn({ ...logCtx, msg }, "Swap simulation warning — proceeding");
  }

  // Gas estimation with fallback
  // IMPORTANT: if estimateGas itself reverts (EstimateGasExecutionError / execution reverted),
  // that means the tx body is bad (invalid signature, slippage exceeded, etc.) and WILL revert
  // on-chain. Do NOT waste gas — throw immediately so the caller can fall back to Li.Fi.
  // Only use the 500k fallback for node/network-level errors (timeout, RPC unavailable, etc.).
  const maxFeeCapWei = BigInt(Math.round(maxGasGwei * 1e9));
  let feeEstimate: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  let estimatedGas: bigint;
  try {
    const [fees, gas] = await Promise.all([
      publicClient.estimateFeesPerGas(),
      publicClient.estimateGas({
        to: routerAddress,
        data: toHex(call.data),
        value: toBigIntSafe(call.value),
        account: account.address,
      }),
    ]);
    feeEstimate = fees;
    estimatedGas = gas;
  } catch (gasErr) {
    const gasErrMsg = gasErr instanceof Error ? gasErr.message : String(gasErr);
    // viem v2 stores error info across multiple fields:
    //   .name        → "EstimateGasExecutionError"
    //   .shortMessage → "Execution reverted for an unknown reason."
    //   .details     → "execution reverted"
    //   .message     → formatted multi-line string (may or may not include "reverted")
    // Checking only .message misses cases where the revert lives in .name/.details/.shortMessage.
    const gasErrName = gasErr instanceof Error ? (gasErr.name ?? "") : "";
    const gasErrDetails = String((gasErr as any)?.details ?? "");
    const gasErrShort = String((gasErr as any)?.shortMessage ?? "");
    const combinedErrText = [gasErrMsg, gasErrName, gasErrDetails, gasErrShort].join(" ");
    const isExecutionRevert =
      combinedErrText.includes("EstimateGasExecutionError") ||
      combinedErrText.toLowerCase().includes("execution reverted") ||
      combinedErrText.toLowerCase().includes("reverted");
    if (isExecutionRevert) {
      // Tx body is known-bad — throwing here causes caller to fall back to Li.Fi
      // instead of spending ETH on a transaction that will definitely revert.
      throw new Error(`Gas estimation reverted — aborting to avoid wasted gas: ${gasErrMsg.slice(0, 300)}`);
    }
    // Node/network error only — use 500k fallback if simulation also passed
    if (simFailed) {
      // Both simulation AND gas estimation failed — the tx is almost certainly bad.
      throw new Error(`Both simulation and gas estimation failed — aborting: ${gasErrMsg.slice(0, 300)}`);
    }
    logger.warn({ ...logCtx, err: gasErrMsg.slice(0, 200) }, "Gas estimation failed (node error) — using 500k fallback");
    feeEstimate = await publicClient.estimateFeesPerGas();
    estimatedGas = 500_000n;
  }
  const maxFeePerGas =
    feeEstimate.maxFeePerGas < maxFeeCapWei ? feeEstimate.maxFeePerGas : maxFeeCapWei;
  const maxPriorityFeePerGas =
    feeEstimate.maxPriorityFeePerGas < maxFeePerGas
      ? feeEstimate.maxPriorityFeePerGas
      : maxFeePerGas;
  const gasLimit = (estimatedGas * 120n) / 100n;

  // Pre-flight ETH balance check — avoid "insufficient funds" error from RPC
  // by detecting it early with a clear log message.
  const txValue = toBigIntSafe(call.value);
  const estimatedCost = gasLimit * maxFeePerGas + txValue;
  const ethBalance = await publicClient.getBalance({ address: account.address });
  if (ethBalance < estimatedCost) {
    throw new Error(
      `Insufficient ETH for gas: wallet has ${formatEther(ethBalance)} ETH, ` +
      `estimated cost ${formatEther(estimatedCost)} ETH ` +
      `(gas ${gasLimit} × maxFeePerGas ${maxFeePerGas} + value ${txValue})`,
    );
  }

  logger.info(
    { ...logCtx, estimatedGas: estimatedGas.toString(), gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString() },
    "Zora sell: gas estimated",
  );

  const txHash = await walletClient.sendTransaction({
    to: routerAddress,
    data: toHex(call.data),
    value: toBigIntSafe(call.value),
    chain: base,
    account,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  logger.info({ ...logCtx, txHash }, "Swap tx submitted");

  let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  } catch (receiptErr) {
    // Receipt timeout: tx was broadcast but we don't know if it landed.
    // Include the txHash in the error so callers can persist it in the DB
    // and the user can manually verify on a block explorer.
    const baseMsg = receiptErr instanceof Error ? receiptErr.message : String(receiptErr);
    throw new Error(`Receipt timeout for txHash ${txHash}: ${baseMsg.slice(0, 200)}`);
  }

  if (receipt.status !== "success") {
    throw new Error(`Swap tx reverted on-chain: ${txHash}`);
  }

  logger.info({ ...logCtx, txHash }, "Swap tx confirmed");
  return txHash;
}

/**
 * Probe current token price (ETH per token) via the Zora Quote API.
 * Returns null if the price cannot be determined (new pool, API issue, etc.).
 *
 * Strategy:
 * 1. Tiny buy quote (PROBE_ETH_WEI → token) — parse amountOut from response
 *    if the API returns it (field names vary by API version).
 * 2. Fallback: GET /coin endpoint for indexed price data.
 *
 * NOTE: For very new tokens (< few blocks old), both probes may return null.
 * The monitor loop simply skips the cycle and retries — this is expected
 * behaviour and will self-resolve as the pool gets indexed.
 */
async function fetchZoraPriceProbe(
  tokenAddress: string,
  sender: string,
): Promise<number | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const _apiKey = nextZoraKey();
  if (_apiKey) headers["x-api-key"] = _apiKey;

  // ── Strategy 1: buy-direction probe ──────────────────────────────────────
  try {
    const body = JSON.stringify({
      chainId: base.id,
      tokenIn: { type: "eth" },
      tokenOut: { type: "erc20", address: tokenAddress.toLowerCase() },
      amountIn: PROBE_ETH_WEI.toString(),
      slippage: 0.5, // generous — probe only, not executed
      sender: sender.toLowerCase(),
      recipient: sender.toLowerCase(),
    });

    const res = await fetch(`${ZORA_QUOTE_API}/quote`, { method: "POST", headers, body });

    if (res.ok) {
      const data = await res.json();
      // Zora API returns amountOut inside the `quote` sub-object
      const amountOutStr: string | undefined = data.quote?.amountOut;

      if (amountOutStr) {
        const tokens = parseFloat(formatUnits(BigInt(amountOutStr), 18));
        if (tokens > 0) {
          return parseFloat(formatEther(PROBE_ETH_WEI)) / tokens;
        }
      }
    }
  } catch (err) {
    logger.warn({ err, tokenAddress }, "Zora price probe (buy-quote path) failed");
  }

  // ── Strategy 2: /coin indexed price → convert USDC price to ETH ──────────
  try {
    const coinRes = await fetch(
      `${ZORA_QUOTE_API}/coin?chainId=${base.id}&address=${tokenAddress.toLowerCase()}`,
    );
    if (coinRes.ok) {
      const coinData = await coinRes.json();
      // Zora API: price lives at zora20Token.tokenPrice.priceInUsdc
      const priceInUsdc: string | undefined =
        coinData?.zora20Token?.tokenPrice?.priceInUsdc;

      if (priceInUsdc) {
        const tokenPriceUsdc = parseFloat(priceInUsdc);
        if (tokenPriceUsdc > 0) {
          // Derive ETH price: probe 1 ETH → USDC to get current ETH/USDC rate
          const ethUsdcRes = await fetch(`${ZORA_QUOTE_API}/quote`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              chainId: base.id,
              tokenIn: { type: "eth" },
              tokenOut: { type: "erc20", address: USDC_BASE.toLowerCase() },
              amountIn: parseEther("1").toString(),
              slippage: 0.5,
              sender: sender.toLowerCase(),
              recipient: sender.toLowerCase(),
            }),
          });
          if (ethUsdcRes.ok) {
            const ethUsdcData = await ethUsdcRes.json();
            const usdcPerEthStr: string | undefined =
              ethUsdcData.quote?.amountOut;
            if (usdcPerEthStr) {
              const usdcPerEth = parseFloat(formatUnits(BigInt(usdcPerEthStr), USDC_DECIMALS));
              if (usdcPerEth > 0) {
                return tokenPriceUsdc / usdcPerEth; // ETH per token
              }
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err, tokenAddress }, "Zora price probe (coin endpoint) failed");
  }

  return null;
}

/**
 * Sell a token position.
 * Primary:  Zora Quote API (token → USDC via Permit2).
 * Fallback: Li.Fi (token → ETH) if Zora API cannot find a route.
 */
export async function executeZoraSell(params: {
  tradeId: number;
  tokenAddress: Address;
  tokenBalance: bigint;
  slippagePercent: number;
  maxGasGwei: number;
  reason: string;
}): Promise<void> {
  try {
    await executeZoraSellViaApi(params);
    return;
  } catch (zoraErr) {
    const msg = zoraErr instanceof Error ? zoraErr.message : String(zoraErr);
    logger.warn({ tradeId: params.tradeId, err: msg }, "Zora API sell failed — falling back to Li.Fi");
  }
  await executeLiFiSell(params);
}

/**
 * Sell via Li.Fi (token → ETH) — used as fallback when Zora API cannot route.
 * Records the result in the trades table and broadcasts the update.
 */
async function executeLiFiSell(params: {
  tradeId: number;
  tokenAddress: Address;
  tokenBalance: bigint;
  slippagePercent: number;
  reason: string;
}): Promise<void> {
  const { tradeId, tokenAddress, tokenBalance, slippagePercent, reason } = params;
  const account = privateKeyToAccount(getWalletKey());
  const httpUrl = getHttpRpcUrl();
  const publicClient = createPublicClient({ chain: base, transport: http(httpUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(httpUrl) });

  logger.info({ tradeId, reason, method: "lifi" }, "executeLiFiSell: starting Li.Fi fallback");

  const sellQuote = await getLiFiQuote(
    tokenAddress,
    ETH_ADDRESS,
    tokenBalance,
    account.address,
    slippagePercent,
  );

  if (sellQuote.estimate.approvalAddress) {
    await ensureApproval(
      publicClient,
      walletClient,
      account,
      tokenAddress,
      sellQuote.estimate.approvalAddress as Address,
      tokenBalance,
    );
  }

  const { transactionRequest: sellTx } = sellQuote;
  let maxFeePerGas: bigint | undefined;
  let maxPriorityFeePerGas: bigint | undefined;
  try {
    const fees = await publicClient.estimateFeesPerGas();
    maxFeePerGas = fees.maxFeePerGas;
    maxPriorityFeePerGas =
      fees.maxPriorityFeePerGas < fees.maxFeePerGas
        ? fees.maxPriorityFeePerGas
        : fees.maxFeePerGas;
  } catch { /* let viem fall back to its own estimation */ }

  // Pre-flight ETH balance check for Li.Fi sell
  const lifiTxValue = BigInt(sellTx.value || "0");
  const lifiGasLimit = sellTx.gasLimit ? BigInt(sellTx.gasLimit) : 500_000n;
  if (maxFeePerGas) {
    const lifiEstimatedCost = lifiGasLimit * maxFeePerGas + lifiTxValue;
    const lifiEthBalance = await publicClient.getBalance({ address: account.address });
    if (lifiEthBalance < lifiEstimatedCost) {
      throw new Error(
        `Li.Fi sell aborted — insufficient ETH for gas: wallet has ${formatEther(lifiEthBalance)} ETH, ` +
        `estimated cost ~${formatEther(lifiEstimatedCost)} ETH`,
      );
    }
  }

  const hash = await walletClient.sendTransaction({
    to: sellTx.to as Address,
    data: sellTx.data as `0x${string}`,
    value: lifiTxValue,
    gas: sellTx.gasLimit ? BigInt(sellTx.gasLimit) : undefined,
    maxFeePerGas,
    maxPriorityFeePerGas,
    account,
    chain: base,
  });

  logger.info({ tradeId, hash }, "Li.Fi sell tx submitted");
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });

  if (receipt.status !== "success") {
    throw new Error("Li.Fi sell tx reverted on-chain");
  }

  const ethRecovered = sellQuote.estimate.toAmountMin
    ? formatEther(BigInt(sellQuote.estimate.toAmountMin))
    : "0";

  const [updated] = await db
    .update(tradesTable)
    .set({ status: "sold", sellTxHash: hash, sellAmountEth: ethRecovered, pnlEth: ethRecovered })
    .where(eq(tradesTable.id, tradeId))
    .returning();

  broadcast("trade", updated);
  logger.info({ tradeId, ethRecovered, reason }, "Sniper sell confirmed via Li.Fi fallback");
}

/**
 * Sell tokens via Zora Quote API (token → USDC).
 * USDC routing is more reliable than ETH for Zora content coins whose pools
 * pair against a creator coin rather than WETH directly.
 * Throws on failure so the caller can fall back to Li.Fi.
 */
async function executeZoraSellViaApi(params: {
  tradeId: number;
  tokenAddress: Address;
  tokenBalance: bigint;
  slippagePercent: number;
  maxGasGwei: number;
  reason: string;
}): Promise<void> {
  const { tradeId, tokenAddress, tokenBalance, slippagePercent, maxGasGwei, reason } = params;
  const slippage = slippagePercent / 100;
  const account = privateKeyToAccount(getWalletKey());
  const httpUrl = getHttpRpcUrl();
  const publicClient = createPublicClient({ chain: base, transport: http(httpUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(httpUrl) });

  const swapCtx = { tradeId, reason };

  // ── Snapshot USDC balance before sell ────────────────────────────────────
  const usdcBefore = await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  // ── Get sell quote (token → USDC) ─────────────────────────────────────────
  const { call: rawCall, permits } = await fetchZoraSellQuote({
    tokenAddress,
    tokenAmountWei: tokenBalance,
    slippage,
    sender: account.address,
  });

  // ── Handle Permit2 if the API returned permit data ────────────────────────
  //
  // New flow (uses the official Zora API `signatures` field):
  //   1. Sign each permit locally (EIP-712 via Permit2).
  //   2. Re-call /quote with the signed permits in the `signatures` array.
  //      The API embeds the signatures directly into the returned calldata —
  //      no injectPermitSignature() byte manipulation needed.
  //   3. Use the calldata from the re-quote as the final transaction payload.
  //
  // This eliminates the fragile placeholder-injection step and ensures the
  // calldata the node simulates is identical to what we submit on-chain.
  let call = rawCall;
  let tokenInAddress: Address | null = tokenAddress; // null → skip approval inside executeZoraSwapTx

  if (permits.length > 0) {
    logger.info({ tradeId, permitsCount: permits.length }, "Signing Permit2 for Zora sell");

    // Approve Permit2 contract to spend tokens (if not already sufficient)
    const permit2Allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, PERMIT2_ADDRESS],
    });
    if (permit2Allowance < tokenBalance) {
      logger.info({ tradeId, spender: PERMIT2_ADDRESS }, "Approving Permit2 contract for sell");
      const approveTx = await walletClient.writeContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [PERMIT2_ADDRESS, maxUint256],
        chain: base,
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
      logger.info({ tradeId, approveTx }, "Permit2 approval confirmed");
    }

    // Sign each permit
    const signedPermits: Array<{ permit: ZoraPermit["permit"]; signature: string }> = [];
    for (const p of permits) {
      const sig = await walletClient.signTypedData({
        account,
        domain: {
          name: "Permit2",
          chainId: base.id,
          verifyingContract: PERMIT2_ADDRESS,
        },
        types: {
          PermitDetails: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint160" },
            { name: "expiration", type: "uint48" },
            { name: "nonce", type: "uint48" },
          ],
          PermitSingle: [
            { name: "details", type: "PermitDetails" },
            { name: "spender", type: "address" },
            { name: "sigDeadline", type: "uint256" },
          ],
        },
        primaryType: "PermitSingle",
        message: {
          details: {
            token: p.permit.details.token as Address,
            amount: BigInt(p.permit.details.amount),
            expiration: p.permit.details.expiration,
            nonce: p.permit.details.nonce,
          },
          spender: p.permit.spender as Address,
          sigDeadline: BigInt(p.permit.sigDeadline),
        },
      });
      signedPermits.push({ permit: p.permit, signature: sig });
      logger.info({ tradeId, sigLength: sig.length }, "Permit2 signature ready");
    }

    // Re-quote with signed permits — API embeds signatures into calldata directly.
    // This replaces the old injectPermitSignature() byte-manipulation approach.
    logger.info({ tradeId, permitsCount: signedPermits.length }, "Re-quoting with signed permits");
    const { call: signedCall } = await fetchZoraQuoteGeneric({
      tokenIn: { type: "erc20", address: tokenAddress.toLowerCase() },
      tokenOut: { type: "erc20", address: USDC_BASE.toLowerCase() },
      amountIn: tokenBalance,
      slippage,
      sender: account.address,
      label: "Zora sell re-quote (with signatures)",
      permitActiveSeconds: 300,
      signatures: signedPermits,
    });

    call = signedCall;
    // Permit2 handles token authorization — skip direct router approval
    tokenInAddress = null;
  }

  const lastTxHash = await executeZoraSwapTx({
    call,
    tokenInAddress,
    tokenInAmount: tokenBalance,
    maxGasGwei,
    publicClient,
    walletClient,
    account,
    logCtx: { ...swapCtx, step: "sell-to-usdc" },
  });

  // ── Calculate USDC received ───────────────────────────────────────────────
  const usdcAfter = await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  const usdcReceived = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n;
  // sellAmountEth field stores USDC received (6 decimals); pnlEth stores same
  const sellAmountUsdc = formatUnits(usdcReceived, USDC_DECIMALS);

  const [updated] = await db
    .update(tradesTable)
    .set({ status: "sold", sellTxHash: lastTxHash, sellAmountEth: sellAmountUsdc, pnlEth: sellAmountUsdc })
    .where(eq(tradesTable.id, tradeId))
    .returning();

  broadcast("trade", updated);
  logger.info(
    { tradeId, sellAmountUsdc, reason },
    "Sniper sell confirmed via Zora API (token → USDC)",
  );
}

// ── executeBuy ──────────────────────────────────────────────────────���─────

export async function executeBuy(params: TradeParams): Promise<void> {
  const {
    tokenAddress,
    tokenName,
    tokenSymbol,
    creatorAddress,
    buyAmountEth,
    slippagePercent,
    maxGasGwei,
    eventName,
    takeProfitPercent,
    stopLossPercent,
  } = params;

  // slippagePercent is stored as e.g. 5.0 → Zora API expects 0.05
  const slippage = slippagePercent / 100;

  logger.info({ tokenAddress, tokenName, buyAmountEth, eventName, slippage }, "Executing buy via Zora Quote API");

  const [tradeRow] = await db
    .insert(tradesTable)
    .values({
      tokenAddress,
      tokenName,
      tokenSymbol,
      creatorAddress,
      buyAmountEth,
      status: "pending",
      takeProfitPercent: takeProfitPercent != null ? String(takeProfitPercent) : null,
      stopLossPercent: stopLossPercent != null ? String(stopLossPercent) : null,
    })
    .returning();

  broadcast("trade", { ...tradeRow, status: "pending" });

  try {
    const account = privateKeyToAccount(getWalletKey());
    const httpUrl = getHttpRpcUrl();
    const publicClient = createPublicClient({ chain: base, transport: http(httpUrl) });
    const walletClient = createWalletClient({ account, chain: base, transport: http(httpUrl) });

    const buyAmountWei = parseEther(buyAmountEth);

    // ── Step 0: Snapshot token balance before buy ─────────────────────────────
    // Read current state (no blockNumber) — works on any node, no archive needed.
    // Historical blockNumber-1n query (old approach) required archive access and
    // often threw because the block wasn't propagated yet at query time.
    let balBeforeBuy = 0n;
    try {
      balBeforeBuy = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
    } catch {
      // If pre-balance read fails (e.g. token not yet deployed), keep 0n
    }

    // ── Step 1: Get quote from Zora API ──────��────────────────────────────────
    const call = await fetchZoraQuote({
      tokenAddress,
      buyAmountWei,
      slippage,
      sender: account.address,
    });

    const value = toBigIntSafe(call.value);

    // ── Step 2: Simulate — revert early before spending gas ───────────────────
    try {
      await publicClient.call({
        to: toHex(call.target) as Address,
        data: toHex(call.data),
        value,
        account: account.address,
      });
      logger.info({ tokenAddress }, "Simulation passed");
    } catch (simErr) {
      const msg = simErr instanceof Error ? simErr.message.slice(0, 200) : String(simErr);
      throw new Error(`Simulation reverted — aborting buy: ${msg}`);
    }

    // ── Step 3: EIP-1559 gas — cap at user-configured maxGasGwei ─────────────
    const maxFeeCapWei = BigInt(Math.round(maxGasGwei * 1e9));
    const [feeEstimate, estimatedGas] = await Promise.all([
      publicClient.estimateFeesPerGas(),
      publicClient.estimateGas({
        to: toHex(call.target) as Address,
        data: toHex(call.data),
        value,
        account: account.address,
      }),
    ]);
    const maxFeePerGas =
      feeEstimate.maxFeePerGas < maxFeeCapWei ? feeEstimate.maxFeePerGas : maxFeeCapWei;
    const maxPriorityFeePerGas =
      feeEstimate.maxPriorityFeePerGas < maxFeePerGas
        ? feeEstimate.maxPriorityFeePerGas
        : maxFeePerGas;
    // Buffer 10% di atas estimasi — cegah out-of-gas untuk Uniswap V4 hook calls
    const gasLimit = (estimatedGas * 110n) / 100n;

    logger.info(
      { estimatedGas: estimatedGas.toString(), gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString() },
      "Gas estimated",
    );

    // ── Step 4: Send transaction ───────────────────────────────────────────────
    const txHash = await walletClient.sendTransaction({
      to: toHex(call.target) as Address,
      data: toHex(call.data),
      value,
      chain: base,
      account,
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    logger.info({ txHash, tokenAddress }, "Buy tx submitted");

    // ── Step 5: Wait for receipt ───────────────────────────────────────────────
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    });

    const gasUsedEth = formatEther(
      receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas),
    );

    // ── Step 6: Measure tokens received via balanceOf diff ────────────────────
    // balBeforeBuy was snapshotted before the tx was sent (see Step 0).
    // We read balAfter at the confirmed block — reliable on non-archive nodes.
    let tokenAmount = "";
    try {
      const balAfter = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
        blockNumber: receipt.blockNumber,
      });
      const received = balAfter > balBeforeBuy ? balAfter - balBeforeBuy : 0n;
      if (received > 0n) {
        tokenAmount = formatUnits(received, 18);
        logger.info({ received: received.toString(), tokenAddress }, "Token amount measured via balanceOf diff");
      } else {
        logger.warn({ balBeforeBuy: balBeforeBuy.toString(), balAfter: balAfter.toString(), tokenAddress }, "balanceOf diff: no increase detected");
      }
    } catch (err) {
      logger.warn({ tokenAddress, err: err instanceof Error ? err.message : String(err) }, "balanceOf diff failed — token amount left blank");
    }

    // Calculate entry price: ETH spent ÷ tokens received
    // tokenAmount is already a decimal string from formatUnits (e.g. "1.0"), so
    // parse it directly — BigInt() cannot handle decimal strings and would throw.
    const tokensNum = tokenAmount ? parseFloat(tokenAmount) : 0;
    const ethNum = parseFloat(buyAmountEth);
    const entryPriceEth = tokensNum > 0 ? (ethNum / tokensNum).toFixed(18) : null;

    const success = receipt.status === "success";
    const [updated] = await db
      .update(tradesTable)
      .set({
        txHash,
        status: success ? "confirmed" : "failed",
        gasUsedEth,
        tokenAmount: tokenAmount || null,
        blockNumber: Number(receipt.blockNumber),
        entryPriceEth: success ? entryPriceEth : null,
      })
      .where(eq(tradesTable.id, tradeRow.id))
      .returning();

    if (success) {
      await db
        .update(creatorsTable)
        .set({ totalSniped: sql`total_sniped + 1` })
        .where(eq(creatorsTable.address, creatorAddress));

      const state = botState.get();
      botState.update({
        totalTrades: state.totalTrades + 1,
        snipedToday: state.snipedToday + 1,
        lastEventAt: new Date().toISOString(),
      });

      // ── Start sniper TP/SL monitor (Zora API) — only for sniper trades.
      // Manual trades have their own Li.Fi-based monitor in routes/manual.ts.
      if ((takeProfitPercent || stopLossPercent) && entryPriceEth) {
        monitorTpSlSniper(
          tradeRow.id,
          tokenAddress,
          parseFloat(entryPriceEth),
          takeProfitPercent ?? null,
          stopLossPercent ?? null,
          slippagePercent,
          maxGasGwei,
        ).catch((err) =>
          logger.error({ err, tradeId: tradeRow.id }, "Sniper TP/SL monitor error"),
        );
        logger.info(
          { tradeId: tradeRow.id, takeProfitPercent, stopLossPercent, entryPriceEth },
          "Sniper TP/SL monitor started (Zora API)",
        );
      }
    } else {
      botState.update({ lastEventAt: new Date().toISOString() });
    }

    broadcast("trade", updated);
    logger.info({ txHash, status: updated.status, tokenName }, "Buy settled");
  } catch (err) {
    const failReason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    logger.error({ err, tokenAddress, failReason }, "Buy failed");
    const [updated] = await db
      .update(tradesTable)
      .set({ status: "failed", failReason })
      .where(eq(tradesTable.id, tradeRow.id))
      .returning();

    botState.update({ lastEventAt: new Date().toISOString() });
    broadcast("trade", updated);
  }
}

export async function getWalletBalance(): Promise<{ address: string; balanceEth: string } | null> {
  try {
    const account = privateKeyToAccount(getWalletKey());
    const publicClient = createPublicClient({ chain: base, transport: http(getHttpRpcUrl()) });
    const balanceWei = await publicClient.getBalance({ address: account.address });
    return {
      address: account.address,
      balanceEth: formatEther(balanceWei),
    };
  } catch {
    return null;
  }
}

export function getWalletAddress(): string | null {
  try {
    const account = privateKeyToAccount(getWalletKey());
    return account.address;
  } catch {
    return null;
  }
}

// ── Sniper TP/SL monitor (Zora API) ──────────────────────────────────────
//
// Separate from the manual trade Li.Fi monitor in routes/manual.ts.
// New Zora coins are not yet indexed by Li.Fi, so price detection via Li.Fi
// would always return null. This monitor uses the Zora Quote API for both
// price probing and the actual sell execution.

/**
 * Background TP/SL monitor for a sniper-bought position.
 * Polls current price via Zora API every 15 seconds.
 * Executes sell (also via Zora API) when TP or SL is hit.
 * Retries sell up to 3 times on failure before giving up.
 */
export async function monitorTpSlSniper(
  tradeId: number,
  tokenAddress: Address,
  entryPriceEth: number,
  takeProfitPercent: number | null,
  stopLossPercent: number | null,
  slippagePercent: number,
  maxGasGwei: number,
): Promise<void> {
  if (!takeProfitPercent && !stopLossPercent) return;

  const tpPrice =
    takeProfitPercent != null ? entryPriceEth * (1 + takeProfitPercent / 100) : null;
  const slPrice =
    stopLossPercent != null ? entryPriceEth * (1 - stopLossPercent / 100) : null;

  logger.info(
    { tradeId, entryPriceEth, tpPrice, slPrice, takeProfitPercent, stopLossPercent },
    "Sniper TP/SL monitor started (Zora API)",
  );

  const account = privateKeyToAccount(getWalletKey());
  const publicClient = createPublicClient({ chain: base, transport: http(getHttpRpcUrl()) });

  const POLL_INTERVAL_MS = 15_000;
  const MAX_SELL_ATTEMPTS = 3;
  let sellAttempts = 0;
  let active = true;

  while (active) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      // Bail if trade was already closed externally (manual sell, etc.)
      const [trade] = await db
        .select({ status: tradesTable.status })
        .from(tradesTable)
        .where(eq(tradesTable.id, tradeId));

      if (!trade || trade.status !== "confirmed") {
        logger.info(
          { tradeId, status: trade?.status },
          "Sniper TP/SL monitor: trade no longer active — exiting",
        );
        return;
      }

      // ── Price probe via Zora API ─────────────────────────────────────────
      const currentPrice = await fetchZoraPriceProbe(tokenAddress, account.address);

      if (currentPrice === null) {
        // Expected for very new tokens; pool needs a few more blocks to be indexed
        logger.debug(
          { tradeId, tokenAddress },
          "Sniper TP/SL: price probe null — pool may still be initialising, retrying",
        );
        continue;
      }

      logger.debug({ tradeId, currentPrice, tpPrice, slPrice }, "Sniper TP/SL price check");

      // ── Check trigger ────────────────────────────────────────────────────
      let reason: "take_profit" | "stop_loss" | null = null;
      if (tpPrice !== null && currentPrice >= tpPrice) reason = "take_profit";
      else if (slPrice !== null && currentPrice <= slPrice) reason = "stop_loss";

      if (!reason) continue;

      // ── Atomic sell claim — prevents double-sell race condition ───────────
      // Between the status check above and this point, a manual sell or another
      // recovery monitor could also read "confirmed" and start selling.
      // We atomically flip status confirmed → selling here; if 0 rows are
      // affected another process already claimed the sell and we bail.
      const [claimed] = await db
        .update(tradesTable)
        .set({ status: "selling" })
        .where(and(eq(tradesTable.id, tradeId), eq(tradesTable.status, "confirmed")))
        .returning({ id: tradesTable.id });

      if (!claimed) {
        logger.warn(
          { tradeId },
          "Sniper TP/SL: sell already claimed by another process — bailing",
        );
        active = false;
        return;
      }

      active = false;
      logger.info(
        { tradeId, reason, currentPrice, tpPrice, slPrice },
        "Sniper TP/SL triggered — executing sell via Zora API",
      );

      // ── Read current token balance ────────────────────────────────────────
      const tokenBalance = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });

      if (tokenBalance === 0n) {
        logger.warn({ tradeId }, "Sniper TP/SL: zero balance — position already closed externally");
        await db
          .update(tradesTable)
          .set({ status: "sold", failReason: "Balance zero at TP/SL trigger" })
          .where(eq(tradesTable.id, tradeId));
        return;
      }

      // ── Execute sell via Zora API ────────────────────────────────────────
      try {
        await executeZoraSell({
          tradeId,
          tokenAddress,
          tokenBalance,
          slippagePercent,
          maxGasGwei,
          reason,
        });
      } catch (sellErr) {
        sellAttempts++;
        logger.error(
          { sellErr, tradeId, sellAttempts, maxAttempts: MAX_SELL_ATTEMPTS },
          "Sniper TP/SL sell attempt failed",
        );
        if (sellAttempts >= MAX_SELL_ATTEMPTS) {
          logger.error({ tradeId }, "Sniper TP/SL: max sell attempts reached — monitor exiting");
          await db
            .update(tradesTable)
            .set({ status: "failed", failReason: "Max TP/SL sell attempts reached" })
            .where(eq(tradesTable.id, tradeId));
          return;
        }
        // Reset to confirmed so the next retry can reclaim the sell
        await db
          .update(tradesTable)
          .set({ status: "confirmed" })
          .where(eq(tradesTable.id, tradeId));
        active = true;
      }
    } catch (err) {
      logger.error({ err, tradeId }, "Sniper TP/SL monitor cycle error");
    }
  }
}

/**
 * On server restart, re-attach Zora-based TP/SL monitors for confirmed sniper
 * trades that still have TP or SL set. Mirrors recoverTpSlMonitors in
 * routes/manual.ts but targets source='sniper' and uses the Zora API monitor.
 */
export async function recoverSniperTpSlMonitors(): Promise<void> {
  try {
    // Reset any trades stuck in "selling" — these were mid-sell when the server
    // crashed.  The sell tx may or may not have landed on-chain; the monitor
    // will re-read price/balance on the next poll cycle and retry if needed.
    const stuckCount = await db
      .update(tradesTable)
      .set({ status: "confirmed" })
      .where(
        and(
          eq(tradesTable.source, "sniper"),
          eq(tradesTable.status, "selling"),
        ),
      );
    if ((stuckCount.rowCount ?? 0) > 0) {
      logger.warn(
        { count: stuckCount.rowCount },
        "Sniper TP/SL recovery: reset stuck 'selling' trades back to 'confirmed'",
      );
    }

    const openTrades = await db
      .select()
      .from(tradesTable)
      .where(
        and(
          eq(tradesTable.source, "sniper"),
          eq(tradesTable.status, "confirmed"),
        ),
      );

    const recoverable = openTrades.filter(
      (t) => (t.takeProfitPercent || t.stopLossPercent) && t.entryPriceEth,
    );

    if (recoverable.length === 0) {
      logger.info("Sniper TP/SL recovery: no active monitors to restart");
      return;
    }

    logger.info({ count: recoverable.length }, "Sniper TP/SL recovery: restarting monitors");

    // Read current config for slippage/gas (applied at sell time)
    const config = await loadConfig();

    for (const trade of recoverable) {
      const entryPrice = parseFloat(trade.entryPriceEth!);
      const tp = trade.takeProfitPercent ? parseFloat(trade.takeProfitPercent) : null;
      const sl = trade.stopLossPercent ? parseFloat(trade.stopLossPercent) : null;

      monitorTpSlSniper(
        trade.id,
        trade.tokenAddress as Address,
        entryPrice,
        tp,
        sl,
        config.slippagePercent,
        config.maxGasGwei,
      ).catch((err) =>
        logger.error({ err, tradeId: trade.id }, "Sniper TP/SL recovery monitor error"),
      );

      logger.info(
        { tradeId: trade.id, token: trade.tokenAddress, tp, sl },
        "Sniper TP/SL monitor recovered",
      );
    }
  } catch (err) {
    logger.error({ err }, "Sniper TP/SL recovery failed — monitors not restarted");
  }
}
