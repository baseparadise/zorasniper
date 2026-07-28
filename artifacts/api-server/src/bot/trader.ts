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

/** WETH address on Base — used to identify ETH-paired pools. */
const WETH_BASE = "0x4200000000000000000000000000000000000006";

/**
 * Generic Zora Quote API caller.
 * tokenIn / tokenOut each follow the Zora API shape:
 *   { type: "eth" } or { type: "erc20", address: "0x..." }
 */
async function fetchZoraQuoteGeneric(params: {
  tokenIn: { type: "eth" } | { type: "erc20"; address: string };
  tokenOut: { type: "eth" } | { type: "erc20"; address: string };
  amountIn: bigint;
  slippage: number; // fractional, e.g. 0.05
  sender: string;
  label?: string; // log label
}): Promise<ZoraCall> {
  const { tokenIn, tokenOut, amountIn, slippage, sender, label = "Zora quote" } = params;
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
      if (data.success === "false" || data.error) {
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

    logger.info({ attempt, target: data.call.target }, `${label} OK`);
    return data.call as ZoraCall;
  }

  throw new Error(`${label} failed after 3 attempts`);
}

/**
 * Fetch a SELL quote from Zora Quote API (erc20 → ETH).
 * Throws ZoraNoRoute error (message starts with "ZoraNoRoute:") if the Zora API
 * cannot find a direct route — the caller can then attempt a two-step sell.
 */
async function fetchZoraSellQuote(params: {
  tokenAddress: string;
  tokenAmountWei: bigint;
  slippage: number; // fractional
  sender: string;
}): Promise<ZoraCall> {
  return fetchZoraQuoteGeneric({
    tokenIn: { type: "erc20", address: params.tokenAddress.toLowerCase() },
    tokenOut: { type: "eth" },
    amountIn: params.tokenAmountWei,
    slippage: params.slippage,
    sender: params.sender,
    label: "Zora sell quote",
  });
}

/**
 * Fetch the pool currency for a Zora coin via the /coin endpoint.
 * Content coins pair against a creator coin; creator coins pair against the ZORA token.
 * Returns null if the endpoint fails or the coin is not found.
 */
async function fetchZoraPoolCurrency(tokenAddress: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    const _apiKey = nextZoraKey();
    if (_apiKey) headers["x-api-key"] = _apiKey;

    const res = await fetch(
      `${ZORA_QUOTE_API}/coin?chainId=${base.id}&address=${tokenAddress.toLowerCase()}`,
      { headers },
    );
    if (!res.ok) return null;

    const data = await res.json();
    const addr: string | undefined = data?.zora20Token?.poolCurrencyToken?.address;
    if (!addr) return null;

    logger.info({ tokenAddress, poolCurrency: addr }, "Zora pool currency detected");
    return addr.toLowerCase();
  } catch (err) {
    logger.warn({ err, tokenAddress }, "fetchZoraPoolCurrency failed");
    return null;
  }
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
  try {
    await publicClient.call({
      to: routerAddress,
      data: toHex(call.data),
      value: toBigIntSafe(call.value),
      account: account.address,
    });
    logger.info(logCtx, "Swap simulation passed");
  } catch (simErr) {
    const msg = simErr instanceof Error ? simErr.message.slice(0, 200) : String(simErr);
    logger.warn({ ...logCtx, msg }, "Swap simulation warning — proceeding");
  }

  // Gas estimation with fallback
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
    logger.warn({ ...logCtx, err: gasErr }, "Gas estimation failed — using 500k fallback");
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
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });

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
      // Try common field names across Zora API versions
      const amountOutStr: string | undefined =
        data.amountOut ??
        data.result?.amountOut ??
        data.swapResult?.amountOut ??
        data.estimate?.toAmount ??
        data.expectedOutput;

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

  // ── Strategy 2: /coin indexed price ──────────────────────────────────────
  try {
    const coinRes = await fetch(
      `${ZORA_QUOTE_API}/coin?chainId=${base.id}&address=${tokenAddress.toLowerCase()}`,
    );
    if (coinRes.ok) {
      const coinData = await coinRes.json();
      const priceEth: string | undefined =
        coinData.priceEth ??
        coinData.currentPriceEth ??
        coinData.price ??
        coinData.coin?.priceEth;
      if (priceEth) return parseFloat(priceEth);
    }
  } catch (err) {
    logger.warn({ err, tokenAddress }, "Zora price probe (coin endpoint) failed");
  }

  return null;
}

/**
 * Approve the Zora router + execute a sell transaction via Zora Quote API.
 * Records sell result in the trades table and broadcasts the update.
 *
 * Two-step sell fallback for creator-coin-paired tokens:
 *   Some Zora content coins (coinType: CONTENT) pool against a creator coin
 *   rather than ETH/WETH directly. The Zora /quote endpoint returns
 *   "SwapError: Failed to get quote" when asked to sell such a token straight
 *   to ETH, because there is no single-hop ETH pool.
 *
 *   On that error we:
 *     1. Fetch the pool currency from /coin (e.g. batnater creator coin).
 *     2. Sell: token → poolCurrency  (hop 1, direct pool — always works).
 *     3. Sell: poolCurrency → ETH    (hop 2, creator coin has an ETH pool).
 *   ETH balance delta across both hops is used for PnL calculation.
 */
export async function executeZoraSell(params: {
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

  // ── Snapshot ETH balance before any sell ─────────────────────────────────
  const ethBefore = await publicClient.getBalance({ address: account.address });

  // ── Attempt 1: direct sell token → ETH ───────────────────────────────────
  let directFailed = false;
  let lastTxHash: `0x${string}` | null = null;
  try {
    const call = await fetchZoraSellQuote({
      tokenAddress,
      tokenAmountWei: tokenBalance,
      slippage,
      sender: account.address,
    });

    lastTxHash = await executeZoraSwapTx({
      call,
      tokenInAddress: tokenAddress,
      tokenInAmount: tokenBalance,
      maxGasGwei,
      publicClient,
      walletClient,
      account,
      logCtx: { ...swapCtx, step: "direct-sell" },
    });
  } catch (directErr) {
    const msg = directErr instanceof Error ? directErr.message : String(directErr);
    if (!msg.startsWith("ZoraNoRoute:")) {
      // Genuine on-chain or network failure — surface immediately
      throw directErr;
    }
    // No direct ETH route → try two-step sell
    logger.warn(
      { tradeId, tokenAddress, msg: msg.slice(0, 120) },
      "Direct Zora sell has no route — checking pool currency for two-step sell",
    );
    directFailed = true;
  }

  // ── Attempt 2: two-step sell for creator-coin-paired tokens ──────────────
  if (directFailed) {
    const poolCurrency = await fetchZoraPoolCurrency(tokenAddress);

    if (!poolCurrency || poolCurrency === WETH_BASE.toLowerCase()) {
      throw new Error(
        `Zora sell failed: no direct ETH route and no usable pool currency found for ${tokenAddress}`,
      );
    }

    logger.info(
      { tradeId, tokenAddress, poolCurrency },
      "Two-step sell: token → poolCurrency → ETH",
    );

    // ── Hop 1: token → creator/pool currency ─────────────────────────────
    const hop1Call = await fetchZoraQuoteGeneric({
      tokenIn: { type: "erc20", address: tokenAddress.toLowerCase() },
      tokenOut: { type: "erc20", address: poolCurrency },
      amountIn: tokenBalance,
      slippage,
      sender: account.address,
      label: "Zora two-step sell hop1 (token→poolCurrency)",
    });

    await executeZoraSwapTx({
      call: hop1Call,
      tokenInAddress: tokenAddress,
      tokenInAmount: tokenBalance,
      maxGasGwei,
      publicClient,
      walletClient,
      account,
      logCtx: { ...swapCtx, step: "two-step-hop1" },
    });
    // hop1 txHash captured for logging; final sellTxHash will be set to hop2

    // ── Hop 2: creator/pool currency → ETH ───────────────────────────────
    // Read the actual amount received from hop 1 (don't assume a fixed amount)
    const poolCurrencyAddr = poolCurrency as Address;
    const poolCurrencyBalance = await publicClient.readContract({
      address: poolCurrencyAddr,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });

    if (poolCurrencyBalance === 0n) {
      throw new Error(
        `Two-step sell hop 1 succeeded but pool currency balance is 0 — cannot execute hop 2`,
      );
    }

    logger.info(
      { tradeId, poolCurrency, poolCurrencyBalance: poolCurrencyBalance.toString() },
      "Two-step sell hop 1 confirmed — executing hop 2 (poolCurrency → ETH)",
    );

    const hop2Call = await fetchZoraSellQuote({
      tokenAddress: poolCurrency,
      tokenAmountWei: poolCurrencyBalance,
      slippage,
      sender: account.address,
    });

    lastTxHash = await executeZoraSwapTx({
      call: hop2Call,
      tokenInAddress: poolCurrencyAddr,
      tokenInAmount: poolCurrencyBalance,
      maxGasGwei,
      publicClient,
      walletClient,
      account,
      logCtx: { ...swapCtx, step: "two-step-hop2" },
    });
  }

  // ── Calculate ETH received (net of gas across all hops) ───────────────────
  const ethAfter = await publicClient.getBalance({ address: account.address });
  // ethAfter - ethBefore already accounts for all gas spent across both hops
  const ethReceivedNet = ethAfter > ethBefore ? ethAfter - ethBefore : 0n;
  const sellAmountEth = formatEther(ethReceivedNet);

  // P&L vs original buy amount
  const [tradeRow] = await db.select().from(tradesTable).where(eq(tradesTable.id, tradeId));
  const buyAmount = parseFloat(tradeRow?.buyAmountEth ?? "0");
  const pnlEth = (parseFloat(sellAmountEth) - buyAmount).toFixed(8);

  const [updated] = await db
    .update(tradesTable)
    .set({ status: "sold", sellTxHash: lastTxHash, sellAmountEth, pnlEth })
    .where(eq(tradesTable.id, tradeId))
    .returning();

  broadcast("trade", updated);
  logger.info(
    { tradeId, sellAmountEth, pnlEth, reason, twoStep: directFailed },
    "Sniper sell confirmed via Zora API",
  );
}

// ── executeBuy ────────────────────────────────────────────────────────────

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

    // ── Step 1: Get quote from Zora API ───────────────────────────────────────
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
    let tokenAmount = "";
    try {
      const [balBefore, balAfter] = await Promise.all([
        publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
          blockNumber: receipt.blockNumber - 1n,
        }),
        publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
          blockNumber: receipt.blockNumber,
        }),
      ]);
      const received = balAfter - balBefore;
      if (received > 0n) {
        tokenAmount = formatUnits(received, 18);
        logger.info({ received: received.toString(), tokenAddress }, "Token amount measured via balanceOf diff");
      }
    } catch {
      logger.warn({ tokenAddress }, "balanceOf diff failed — token amount left blank");
    }

    // Calculate entry price: ETH spent ÷ tokens received
    const tokensNum = tokenAmount ? parseFloat(formatUnits(BigInt(tokenAmount), 18)) : 0;
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
          return;
        }
        // Re-activate to retry on the next poll cycle
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
