import { Router, type IRouter } from "express";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  formatUnits,
  maxUint256,
  type Address,
  type Account,
} from "viem";
import { getLiFiQuote, ETH_ADDRESS } from "../lib/lifi";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { db, tradesTable, type Trade } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { executeZoraSell, monitorTpSlSniper } from "../bot/trader";
import { loadConfig } from "../lib/config";
import { z } from "zod/v4";

const router: IRouter = Router();

// ── Constants ──────────────────────────────────────────────────────────────

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const BASE_CHAIN_ID = 8453; // used for Zora Quote API chain param
/** USDC on Base — primary Zora sell output (more reliable routing than ETH for Zora Coins). */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const USDC_DECIMALS = 6;

// ── ABI definitions ─────────��──────────────────────────────────────────────

const ERC20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────

function getHttpRpcUrl(): string {
  const url = process.env.ALCHEMY_RPC_URL ?? "";
  return url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

function getWalletKey(): `0x${string}` {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) throw new Error("WALLET_PRIVATE_KEY is not set");
  return key.startsWith("0x") ? (key as `0x${string}`) : `0x${key}`;
}

function makePublicClient() {
  return createPublicClient({ chain: base, transport: http(getHttpRpcUrl()) });
}

/**
 * Ensure a hex string is valid and has the 0x prefix.
 * Zora API sometimes omits the prefix, and may include whitespace/newlines
 * in the JSON response. Throws immediately if the result is not valid hex.
 */
function toHex(s: string): `0x${string}` {
  if (!s) return "0x";
  const stripped = s.trim().replace(/[\s\r\n]/g, "");
  const clean = stripped.startsWith("0x") ? stripped : `0x${stripped}`;
  if (!/^0x[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`toHex: invalid hex from Zora API (first 80 chars): ${clean.slice(0, 80)}`);
  }
  return clean as `0x${string}`;
}

/** Safely parse a bigint from a string that may be null/undefined/empty. */
function toBigIntSafe(s: string | null | undefined, fallback = 0n): bigint {
  if (!s || s === "") return fallback;
  try { return BigInt(s); } catch { return fallback; }
}

// ── Zora Quote API integration ─────────────────────────────────────────────
//
// Mirrors the exact logic used by trader.ts (sniper bot).
// Manual buy attempts Zora first; falls back to Li.Fi if Zora cannot route
// the token (i.e. it is not a Zora Coin or its pool is not available).

const ZORA_QUOTE_API = "https://api-sdk.zora.engineering";


// Supports multiple keys via ZORA_API_KEYS (comma-separated) or ZORA_API_KEY.
const ZORA_API_KEYS: string[] = (() => {
  const multi = process.env.ZORA_API_KEYS;
  if (multi) return multi.split(",").map((k) => k.trim()).filter(Boolean);
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

/**
 * Fetch live market data (price + MC) for a token from the Zora /coin API.
 * Returns { priceUsd, mcUsd } or null if unavailable.
 * Single API call shared by the /positions endpoint so both price and MC
 * come from one request — no duplicate calls per card.
 */
async function fetchTokenMarketData(tokenAddress: string): Promise<{ priceUsd: number; mcUsd: number } | null> {
  try {
    const hdrs: Record<string, string> = {};
    const apiKey = nextZoraKey();
    if (apiKey) hdrs["x-api-key"] = apiKey;
    const r = await fetch(
      `${ZORA_QUOTE_API}/coin?chainId=8453&address=${tokenAddress.toLowerCase()}`,
      { headers: hdrs, signal: AbortSignal.timeout(10_000) },
    );
    if (r.ok) {
      const data = await r.json();
      const token = data?.coin ?? data?.zora20Token;
      const priceInUsdc: string | undefined = token?.tokenPrice?.priceInUsdc ?? token?.price;
      const marketCap: string | number | undefined = token?.marketCap ?? token?.tokenPrice?.marketCap;
      const priceUsd = priceInUsdc ? parseFloat(priceInUsdc) : 0;
      if (priceUsd > 0) {
        return { priceUsd, mcUsd: marketCap ? parseFloat(String(marketCap)) : 0 };
      }
    }
  } catch (err) {
    logger.warn({ err, tokenAddress }, "fetchTokenMarketData: /coin endpoint failed");
  }
  return null;
}

/** Thin wrapper used by buy flows that only need price. */
async function fetchTokenPriceUsdc(tokenAddress: string): Promise<number | null> {
  const data = await fetchTokenMarketData(tokenAddress);
  return data ? data.priceUsd : null;
}

// Small ETH amount used as a price probe — never actually submitted as a tx.
const PROBE_ETH_WEI = parseEther("0.001");
const PROBE_AMOUNT_ETH = "0.001";

interface ZoraCall {
  target: string;
  data: string;
  value: string;
}

interface ZoraQuoteResult {
  call: ZoraCall;
  /** Raw token amount out (string, 18 decimals) from the API response. May be
   *  undefined if the API does not include it in this version. */
  amountOut: string | null;
}

/**
 * Fetch a BUY quote from Zora Quote API (ETH → erc20).
 * Identical to the implementation in trader.ts (sniper path).
 * Retries up to 3 times with a 5-second delay — Zora pools need a few blocks
 * after deployment before they are ready to quote.
 *
 * Returns both the calldata (needed for tx submission) and amountOut
 * (used by the simulate endpoint to show accurate price estimates for the
 * actual buy amount, avoiding the probe-vs-real-amount price impact gap).
 */
async function fetchZoraQuote(params: {
  tokenAddress: string;
  buyAmountWei: bigint;
  slippage: number; // fractional, e.g. 0.05 for 5%
  sender: string;
}): Promise<ZoraQuoteResult> {
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
      // Only retry for "pool not ready yet" messages — specific to newly deployed
      // Zora Coin pools that need a few blocks before they are quotable.
      // A plain 400 without those markers means the token is simply not on Zora
      // (e.g. USDC, WETH, arbitrary ERC20) — throw immediately so Li.Fi fallback
      // kicks in without a ~10 s delay.
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

    const amountOut: string | null =
      data.quote?.amountOut ??
      data.amountOut ??
      data.result?.amountOut ??
      data.swapResult?.amountOut ??
      null;

    logger.info({ attempt, target: data.call.target, amountOut }, "Zora buy quote OK");
    return { call: data.call as ZoraCall, amountOut };
  }

  throw new Error("Zora quote failed after 3 attempts — pool not ready or token invalid");
}

/**
 * Probe current token price (ETH per token) via the Zora Quote API.
 *
 * Strategy:
 * 1. Sell-direction quote (token → USDC) — same endpoint/direction as the TP/SL monitor.
 *    If this works, the monitor will work too; if it fails here, the monitor would also fail.
 *    Uses probeAmountWei (wallet balance if held, else 1 token) to derive price per token,
 *    then converts USDC → ETH via a 1 ETH → USDC rate probe.
 * 2. Fallback: GET /coin endpoint for indexed price data.
 *
 * Returns null if the price cannot be determined (new pool, API issue, etc.).
 */
async function fetchZoraPriceProbe(tokenAddress: string, sender: string, probeAmountWei: bigint): Promise<number | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const _apiKey = nextZoraKey();
  if (_apiKey) headers["x-api-key"] = _apiKey;

  // ── Strategy 1: sell-direction quote (mirrors TP/SL monitor) ──────────
  // token → USDC, same Zora endpoint as monitorTpSlSniper/fetchCurrentValueUsdc.
  // Serving as a live canary: if this passes, the monitor's price check will too.
  try {
    const body = JSON.stringify({
      chainId: base.id,
      tokenIn: { type: "erc20", address: tokenAddress.toLowerCase() },
      tokenOut: { type: "erc20", address: USDC_BASE.toLowerCase() },
      amountIn: probeAmountWei.toString(),
      slippage: 0.5,
      sender: sender.toLowerCase(),
      recipient: sender.toLowerCase(),
    });

    const res = await fetch(`${ZORA_QUOTE_API}/quote`, { method: "POST", headers, body });

    if (res.ok) {
      const data = await res.json();
      const usdcOutStr: string | undefined = data.quote?.amountOut;

      if (usdcOutStr && usdcOutStr !== "0") {
        const usdcOut = parseFloat(formatUnits(BigInt(usdcOutStr), USDC_DECIMALS));
        const probeTokens = parseFloat(formatUnits(probeAmountWei, 18));
        if (usdcOut > 0 && probeTokens > 0) {
          const priceUsdc = usdcOut / probeTokens; // USDC per token

          // Convert USDC → ETH: get how much USDC 1 ETH buys via Zora
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
            const usdcPerEthStr: string | undefined = ethUsdcData.quote?.amountOut;
            if (usdcPerEthStr) {
              const usdcPerEth = parseFloat(formatUnits(BigInt(usdcPerEthStr), USDC_DECIMALS));
              if (usdcPerEth > 0) {
                return priceUsdc / usdcPerEth; // ETH per token
              }
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err, tokenAddress }, "Zora price probe (sell-direction) failed");
  }

  // ── Strategy 2: /coin indexed price ───────────────────────────────────
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
          // Convert USDC price → ETH price using a 1 ETH → USDC probe
          const ethUsdcRes = await fetch(`${ZORA_QUOTE_API}/quote`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              chainId: base.id,
              tokenIn: { type: "eth" },
              tokenOut: { type: "erc20", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }, // USDC Base
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
              const usdcPerEth = parseFloat(formatUnits(BigInt(usdcPerEthStr), 6));
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

// ── Li.Fi integration ──────────────────────────────────────────────────────


// ── Buy executors ──────────────────────────────────────────────────────────

/**
 * Execute a manual buy via Zora Quote API.
 * Mirrors the sniper's executeBuy logic exactly:
 *   simulate → EIP-1559 gas estimate (capped at config.maxGasGwei)
 *   → send tx → wait → balanceOf diff (block-level) for actual tokens → DB update.
 *
 * Called ONLY after a successful Zora quote. Does not handle fallback —
 * the caller (runBuy) decides Zora vs Li.Fi before calling this.
 *
 * Returns the ETH-per-token entry price, or 0 if the tx reverts.
 * Throws on any error so the outer handler can record the failure.
 */
async function executeViaZora(
  tradeId: number,
  tokenAddress: Address,
  buyAmountEth: string,
  call: ZoraCall,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<number> {
  const httpUrl = getHttpRpcUrl();
  const publicClient = createPublicClient({ chain: base, transport: http(httpUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(httpUrl) });
  const value = toBigIntSafe(call.value);

  // Load config for gas cap — sensible default if config unavailable
  let maxGasGwei = 10;
  try {
    const config = await loadConfig();
    maxGasGwei = config.maxGasGwei;
  } catch { /* proceed with default */ }

  // ── Step 0: Snapshot token balance before buy ─────────────────────────
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

  // ── Simulate — abort early before spending gas ──────────────────────────
  try {
    await publicClient.call({
      to: toHex(call.target) as Address,
      data: toHex(call.data),
      value,
      account: account.address,
    });
    logger.info({ tradeId, tokenAddress }, "Zora manual buy: simulation passed");
  } catch (simErr) {
    const msg = simErr instanceof Error ? simErr.message.slice(0, 200) : String(simErr);
    throw new Error(`Zora simulation reverted — aborting buy: ${msg}`);
  }

  // ── EIP-1559 gas — capped at maxGasGwei ────────────────────────────────
  const maxFeeCapWei = BigInt(Math.round(maxGasGwei * 1e9));
  let feeEstimate: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  let estimatedGas: bigint;
  try {
    const [fees, gas] = await Promise.all([
      publicClient.estimateFeesPerGas(),
      publicClient.estimateGas({
        to: toHex(call.target) as Address,
        data: toHex(call.data),
        value,
        account: account.address,
      }),
    ]);
    feeEstimate = fees;
    estimatedGas = gas;
  } catch (gasErr) {
    logger.warn({ tradeId, err: gasErr }, "Gas estimation failed — using 500k fallback");
    feeEstimate = await publicClient.estimateFeesPerGas();
    estimatedGas = 500_000n;
  }
  const maxFeePerGas =
    feeEstimate.maxFeePerGas < maxFeeCapWei ? feeEstimate.maxFeePerGas : maxFeeCapWei;
  const maxPriorityFeePerGas =
    feeEstimate.maxPriorityFeePerGas < maxFeePerGas
      ? feeEstimate.maxPriorityFeePerGas
      : maxFeePerGas;
  // Buffer 10% above estimate — guard against Uniswap V4 hook call overhead
  const gasLimit = (estimatedGas * 110n) / 100n;

  logger.info(
    { tradeId, estimatedGas: estimatedGas.toString(), gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString() },
    "Zora manual buy: gas estimated",
  );

  // ── Send transaction ────────────────────────────────────────────────────
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

  logger.info({ tradeId, txHash, tokenAddress }, "Zora manual buy tx submitted");

  // ── Wait for receipt ────────────────────────────────────────────────────
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  const gasUsedEth = formatEther(receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas));

  // ── Measure tokens received via balanceOf diff ─────────────────────────
  // balBeforeBuy was snapshotted before the tx was sent (see Step 0).
  // Read at "latest" — after waitForTransactionReceipt the tx is confirmed so
  // latest >= receipt.blockNumber. Specifying receipt.blockNumber caused
  // "Requested resource not found" on Alchemy nodes (block not cached yet).
  let tokenAmount = "";
  try {
    const balAfter = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    const received = balAfter > balBeforeBuy ? balAfter - balBeforeBuy : 0n;
    if (received > 0n) {
      tokenAmount = formatUnits(received, 18);
      logger.info({ tradeId, received: received.toString(), tokenAddress }, "Token amount measured via balanceOf diff");
    } else {
      logger.warn({ tradeId, balBeforeBuy: balBeforeBuy.toString(), balAfter: balAfter.toString(), tokenAddress }, "balanceOf diff: no increase detected");
    }
  } catch (err) {
    logger.warn({ tradeId, tokenAddress, err: err instanceof Error ? err.message : String(err) }, "balanceOf diff failed — token amount left blank");
  }

  const tokensNum = tokenAmount ? parseFloat(tokenAmount) : 0;
  const ethNum = parseFloat(buyAmountEth);
  const entryPriceNum = tokensNum > 0 ? ethNum / tokensNum : 0;
  const entryPriceStr = entryPriceNum > 0 ? entryPriceNum.toFixed(18) : null;

  const success = receipt.status === "success";

  if (success) {
    // Fetch USDC price to store entryValueUsdc — used by the unified TP/SL monitor
    let entryValueUsdcStr: string | null = null;
    if (tokensNum > 0) {
      try {
        const priceUsdc = await fetchTokenPriceUsdc(tokenAddress);
        if (priceUsdc !== null) {
          entryValueUsdcStr = (tokensNum * priceUsdc).toFixed(6);
        }
      } catch { /* price unavailable — leave null */ }
    }

    await db
      .update(tradesTable)
      .set({
        status: "confirmed",
        txHash,
        gasUsedEth,
        tokenAmount: tokenAmount || null,
        entryPriceEth: entryPriceStr,
        entryValueUsdc: entryValueUsdcStr,
        blockNumber: Number(receipt.blockNumber),
      })
      .where(eq(tradesTable.id, tradeId));

    logger.info({ tradeId, txHash, gasUsedEth, tokenAmount, entryPriceNum, entryValueUsdcStr }, "Manual buy confirmed via Zora API");
    return entryPriceNum;
  } else {
    await db
      .update(tradesTable)
      .set({ status: "failed", failReason: "Zora swap tx reverted on-chain", txHash })
      .where(eq(tradesTable.id, tradeId));
    logger.warn({ tradeId, txHash }, "Zora manual buy tx reverted");
    return 0;
  }
}

/**
 * Execute a manual buy via Li.Fi (fallback path).
 * Used when Zora quote is unavailable (non-Zora token or pool not routable).
 * Returns the ETH-per-token entry price, or 0 on failure.
 */
async function executeViaLiFi(
  tradeId: number,
  tokenAddress: Address,
  buyAmountEth: string,
  slippagePercent: number,
): Promise<number> {
  const account = privateKeyToAccount(getWalletKey());
  const publicClient = makePublicClient();
  const walletClient = createWalletClient({ account, chain: base, transport: http(getHttpRpcUrl()) });

  const fromAmountWei = parseEther(buyAmountEth);

  const quote = await getLiFiQuote(
    ETH_ADDRESS,
    tokenAddress,
    fromAmountWei,
    account.address,
    slippagePercent,
  );

  const { transactionRequest, estimate, tool } = quote;
  logger.info(
    { tradeId, tool, expectedOut: estimate.toAmount, minOut: estimate.toAmountMin },
    "Li.Fi quote received",
  );

  // ── Snapshot token balance BEFORE sending tx ─────────────────────────────
  // Must read current state before the tx so the diff is accurate even if
  // the wallet already holds some of the same token.
  let balBeforeBuy = 0n;
  try {
    balBeforeBuy = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
  } catch {
    // Keep 0n — diff will still be correct for a fresh position
  }

  const hash = await walletClient.sendTransaction({
    to: transactionRequest.to as Address,
    data: transactionRequest.data as `0x${string}`,
    value: BigInt(transactionRequest.value || "0"),
    gas: transactionRequest.gasLimit ? BigInt(transactionRequest.gasLimit) : undefined,
    account,
    chain: base,
  });

  logger.info({ tradeId, hash }, "Li.Fi buy tx submitted");

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status === "success") {
    const gasUsedEth = formatEther(receipt.gasUsed * receipt.effectiveGasPrice);

    // ── Measure tokens received via balanceOf diff ────────────────────────
    // balBeforeBuy was snapshotted before the tx was sent.
    // Fall back to estimate.toAmountMin only if the on-chain read fails.
    let tokenAmount = "0";
    try {
      const balAfter = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      const received = balAfter > balBeforeBuy ? balAfter - balBeforeBuy : 0n;
      if (received > 0n) {
        tokenAmount = formatUnits(received, 18);
        logger.info({ tradeId, received: received.toString(), tokenAddress }, "Token amount measured via balanceOf diff (Li.Fi)");
      } else if (estimate.toAmountMin && BigInt(estimate.toAmountMin) > 0n) {
        tokenAmount = formatUnits(BigInt(estimate.toAmountMin), 18);
        logger.warn({ tradeId, tokenAddress }, "balanceOf diff: no increase detected — using estimate.toAmountMin");
      }
    } catch {
      if (estimate.toAmountMin && BigInt(estimate.toAmountMin) > 0n) {
        tokenAmount = formatUnits(BigInt(estimate.toAmountMin), 18);
      }
    }

    const tokensNum = parseFloat(tokenAmount);
    const ethNum = parseFloat(buyAmountEth);
    const entryPriceNum = tokensNum > 0 ? ethNum / tokensNum : 0;
    const entryPriceStr = entryPriceNum > 0 ? entryPriceNum.toFixed(18) : null;

    // Fetch USDC price to store entryValueUsdc — used by the unified TP/SL monitor
    let entryValueUsdcStr: string | null = null;
    if (tokensNum > 0) {
      try {
        const priceUsdc = await fetchTokenPriceUsdc(tokenAddress);
        if (priceUsdc !== null) {
          entryValueUsdcStr = (tokensNum * priceUsdc).toFixed(6);
        }
      } catch { /* price unavailable — leave null */ }
    }

    await db
      .update(tradesTable)
      .set({
        status: "confirmed",
        txHash: hash,
        gasUsedEth,
        tokenAmount,
        entryPriceEth: entryPriceStr,
        entryValueUsdc: entryValueUsdcStr,
        blockNumber: Number(receipt.blockNumber),
      })
      .where(eq(tradesTable.id, tradeId));

    logger.info({ tradeId, hash, gasUsedEth, tokenAmount, entryPriceNum, entryValueUsdcStr }, "Manual buy confirmed via Li.Fi");
    return entryPriceNum;
  } else {
    await db
      .update(tradesTable)
      .set({ status: "failed", failReason: "Li.Fi swap tx reverted on-chain" })
      .where(eq(tradesTable.id, tradeId));
    logger.warn({ tradeId, hash }, "Li.Fi buy tx reverted");
    return 0;
  }
}

/**
 * Main buy executor: tries Zora Quote API first (same logic as sniper bot).
 * Falls back to Li.Fi if the Zora QUOTE fails — meaning the token is not a
 * Zora Coin or its pool is not routable.
 *
 * Fallback decision is made at the QUOTE stage only. Once a tx is submitted
 * via either path, no cross-path fallback occurs (prevents double-spending ETH).
 *
 * Returns the actual ETH-per-token entry price, or 0 on failure.
 */
async function runBuy(
  tradeId: number,
  tokenAddress: Address,
  buyAmountEth: string,
  slippagePercent: number,
): Promise<number> {
  try {
    const account = privateKeyToAccount(getWalletKey());
    const slippage = slippagePercent / 100;
    const buyAmountWei = parseEther(buyAmountEth);

    // ── Step 1: Attempt Zora Quote ─────────────────────────────────────────
    // If the quote succeeds the token is a routable Zora Coin — use Zora path.
    // If the quote fails (not a Zora token / pool not available) — use Li.Fi.
    let zoraCall: ZoraCall | null = null;
    try {
      const zoraResult = await fetchZoraQuote({
        tokenAddress,
        buyAmountWei,
        slippage,
        sender: account.address,
      });
      zoraCall = zoraResult.call;
      logger.info(
        { tradeId, target: zoraCall.target },
        "Manual buy: Zora quote OK — using Zora path",
      );
    } catch (zoraQuoteErr) {
      const msg = zoraQuoteErr instanceof Error ? zoraQuoteErr.message : String(zoraQuoteErr);
      logger.warn(
        { tradeId, msg: msg.slice(0, 200) },
        "Manual buy: Zora quote failed — falling back to Li.Fi",
      );
    }

    // ── Step 2: Execute via the chosen path ────────────────────────────────
    if (zoraCall) {
      return await executeViaZora(tradeId, tokenAddress, buyAmountEth, zoraCall, account);
    } else {
      return await executeViaLiFi(tradeId, tokenAddress, buyAmountEth, slippagePercent);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(tradesTable)
      .set({ status: "failed", failReason: msg.slice(0, 500) })
      .where(eq(tradesTable.id, tradeId));
    logger.error({ err, tradeId }, "Manual buy execution failed");
    return 0;
  }
}

// ── Market sell helpers ───────────────────────────────────────────────────

/**
 * Execute an immediate market sell.
 * Delegates to the unified sell function (trader.ts → executeZoraSell):
 * 0x API (primary) → Li.Fi (fallback).
 * Both sniper and manual positions use this same path.
 */
async function runMarketSell(
  tradeId: number,
  tokenAddress: Address,
  rawBal: bigint,
): Promise<void> {
  let slippagePercent = 10;
  let maxGasGwei = 10;
  try {
    const config = await loadConfig();
    slippagePercent = config.slippagePercent;
    maxGasGwei = config.maxGasGwei;
  } catch { /* use defaults */ }

  try {
    await executeZoraSell({
      tradeId,
      tokenAddress,
      tokenBalance: rawBal,
      slippagePercent,
      maxGasGwei,
      reason: "manual_sell",
    });
  } catch (err) {
    const failReason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    logger.error({ err, tradeId, failReason }, "Market sell failed (0x + Li.Fi both failed)");
    await db
      .update(tradesTable)
      .set({ status: "confirmed", failReason })
      .where(eq(tradesTable.id, tradeId));
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

const ManualBuyBody = z.object({
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid address"),
  buyAmountEth: z.string().default("0.01"),
  slippagePercent: z.number().min(0).max(50).default(5),
  takeProfitPercent: z.number().nullable().optional(),
  stopLossPercent: z.number().nullable().optional(),
});

router.post("/trades/manual-buy", async (req, res): Promise<void> => {
  const parsed = ManualBuyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }

  const { tokenAddress, buyAmountEth, slippagePercent, takeProfitPercent, stopLossPercent } =
    parsed.data;
  const addr = tokenAddress as Address;
  const publicClient = makePublicClient();

  // Read token name/symbol
  let tokenName = "Unknown";
  let tokenSymbol = "???";
  try {
    const [n, s] = await Promise.all([
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" }),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
    ]);
    tokenName = n as string;
    tokenSymbol = s as string;
  } catch {
    /* proceed with defaults */
  }

  // ── Entry price probe: Zora first, Li.Fi fallback ────────────────────────
  let entryPriceEth = 0;
  try {
    let probeAccount: Address;
    try { probeAccount = privateKeyToAccount(getWalletKey()).address; } catch { probeAccount = ZERO_ADDRESS; }

    // Sell-direction Zora probe (same as TP/SL monitor). Pre-buy so no balance held yet — probe 1 token.
    const zoraPrice = await fetchZoraPriceProbe(addr, probeAccount, parseUnits("1", 18));
    if (zoraPrice !== null) {
      entryPriceEth = zoraPrice;
    }
  } catch {
    /* price probe failed — entry price stays 0 */
  }

  const [tradeRow] = await db
    .insert(tradesTable)
    .values({
      tokenAddress,
      tokenName,
      tokenSymbol,
      creatorAddress: ZERO_ADDRESS,
      buyAmountEth,
      status: "pending",
      source: "manual",
      takeProfitPercent: takeProfitPercent?.toString() ?? null,
      stopLossPercent: stopLossPercent?.toString() ?? null,
      entryPriceEth: entryPriceEth > 0 ? entryPriceEth.toFixed(18) : null,
    })
    .returning();

  runBuy(tradeRow.id, addr, buyAmountEth, slippagePercent).then(async () => {
    if (takeProfitPercent || stopLossPercent) {
      // Read entryValueUsdc saved by executeViaZora/executeViaLiFi after buy confirmation.
      // Use the unified USD-based monitor (same as sniper) for consistent TP/SL behaviour.
      try {
        const [updatedTrade] = await db
          .select({ entryValueUsdc: tradesTable.entryValueUsdc })
          .from(tradesTable)
          .where(eq(tradesTable.id, tradeRow.id));
        const entryValueUsdc = updatedTrade?.entryValueUsdc
          ? parseFloat(updatedTrade.entryValueUsdc)
          : 0;
        if (entryValueUsdc > 0) {
          const config = await loadConfig();
          monitorTpSlSniper(
            tradeRow.id,
            addr,
            entryValueUsdc,
            takeProfitPercent ?? null,
            stopLossPercent ?? null,
            config.slippagePercent,
            config.maxGasGwei,
          ).catch(err => logger.error({ err, tradeId: tradeRow.id }, "TP/SL monitor error"));
        } else {
          logger.warn({ tradeId: tradeRow.id }, "TP/SL monitor skipped — entryValueUsdc not available after buy");
        }
      } catch (err) {
        logger.error({ err, tradeId: tradeRow.id }, "TP/SL monitor setup failed");
      }
    }
  });

  res.status(201).json(tradeRow);
});

// ── Simulate (dry-run: Zora quote first, Li.Fi fallback) ────────────────────

const SimulateBody = z.object({
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid address"),
  buyAmountEth: z.string().optional().default("0.001"),
});

router.post("/manual/simulate", async (req, res): Promise<void> => {
  const parsed = SimulateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }

  const { tokenAddress, buyAmountEth } = parsed.data;
  const addr = tokenAddress as Address;
  const publicClient = makePublicClient();

  const result: {
    success: boolean;
    tokenName: string | null;
    tokenSymbol: string | null;
    tokenAddress: string;
    buyAmountEth: string;
    expectedTokensOut: string | null;
    minOrderSize: string | null;
    entryPriceEth: string | null;
    route: string | null; // "zora" | "lifi" | "unknown"
    errorReason: string | null;
    checks: { tokenReadable: boolean; buySimulatable: boolean };
  } = {
    success: false,
    tokenName: null,
    tokenSymbol: null,
    tokenAddress,
    buyAmountEth,
    expectedTokensOut: null,
    minOrderSize: null,
    entryPriceEth: null,
    route: null,
    errorReason: null,
    checks: { tokenReadable: false, buySimulatable: false },
  };

  // Step 1: Read token name/symbol
  try {
    const [name, symbol] = await Promise.all([
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" }),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
    ]);
    result.tokenName = name as string;
    result.tokenSymbol = symbol as string;
    result.checks.tokenReadable = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errorReason = `Token not readable on-chain: ${msg.slice(0, 200)}`;
    res.json(result);
    return;
  }

  let simAccount: Address;
  try { simAccount = privateKeyToAccount(getWalletKey()).address; } catch { simAccount = ZERO_ADDRESS; }

  // Step 2a: Try Zora Quote
  try {
    const { amountOut: zoraAmountOut } = await fetchZoraQuote({
      tokenAddress,
      buyAmountWei: parseEther(buyAmountEth),
      slippage: 0.05,
      sender: simAccount,
    });

    // Use amountOut directly from the quote response — this reflects actual
    // price impact for the requested buyAmountEth, unlike the 0.001 ETH probe.
    if (zoraAmountOut) {
      const tokensOut = parseFloat(formatUnits(BigInt(zoraAmountOut), 18));
      const ethNum = parseFloat(buyAmountEth);
      if (tokensOut > 0) {
        result.expectedTokensOut = tokensOut.toFixed(6);
        result.minOrderSize = (tokensOut * 0.95).toFixed(6); // 5% slippage floor
        result.entryPriceEth = (ethNum / tokensOut).toFixed(18);
      }
    }

    result.route = "zora";
    result.checks.buySimulatable = true;
    result.success = true;

    req.log.info({ tokenAddress, buyAmountEth, route: "zora" }, "Simulate complete via Zora");
    res.json(result);
    return;
  } catch {
    // Zora not available — fall through to Li.Fi
  }

  // Step 2b: Li.Fi fallback
  try {
    const quote = await getLiFiQuote(
      ETH_ADDRESS,
      addr,
      parseEther(buyAmountEth),
      simAccount,
      5,
    );

    const tokensNum = parseFloat(formatUnits(BigInt(quote.estimate.toAmount), 18));
    const ethNum = parseFloat(buyAmountEth);
    const entryPrice = tokensNum > 0 ? (ethNum / tokensNum).toFixed(18) : "0";

    result.checks.buySimulatable = true;
    result.expectedTokensOut = formatUnits(BigInt(quote.estimate.toAmount), 18);
    result.minOrderSize = formatUnits(BigInt(quote.estimate.toAmountMin), 18);
    result.entryPriceEth = entryPrice;
    result.route = quote.tool ?? "lifi";
    result.success = true;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    result.errorReason = `Simulation failed (Zora + Li.Fi): ${raw.split("\n")[0].slice(0, 300)}`;
  }

  req.log.info({ tokenAddress, buyAmountEth, success: result.success, route: result.route }, "Simulate complete");
  res.json(result);
});

// ── Token info ─────────────────────────────────────────────────────────────

router.get("/token/:address", async (req, res): Promise<void> => {
  const address = req.params.address as string | undefined;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    res.status(400).json({ error: "valid 0x token address required" });
    return;
  }

  const addr = address as Address;

  try {
    // ── Fetch coin details from Zora SDK API (GET /coin) ─────────────────
    // Primary source for name, symbol, totalSupply, and price.
    // Much more reliable than viem RPC calls + sell-direction price probes.
    const coinHeaders: Record<string, string> = { "Content-Type": "application/json" };
    const _apiKey = nextZoraKey();
    if (_apiKey) coinHeaders["x-api-key"] = _apiKey;

    const coinRes = await fetch(
      `${ZORA_QUOTE_API}/coin?address=${addr.toLowerCase()}&chain=${BASE_CHAIN_ID}`,
      { headers: coinHeaders },
    );

    if (!coinRes.ok) {
      const text = await coinRes.text().catch(() => "");
      req.log.warn({ address, status: coinRes.status, body: text.slice(0, 100) }, "Zora /coin fetch failed");
      res.status(404).json({ error: "Token not found or not a Zora coin" });
      return;
    }

    const coinData = await coinRes.json();
    // Zora SDK API returns data under `coin` or `zora20Token` depending on version
    const token = coinData?.coin ?? coinData?.zora20Token;

    if (!token) {
      req.log.warn({ address, coinData: JSON.stringify(coinData).slice(0, 200) }, "Zora /coin: unexpected response shape");
      res.status(404).json({ error: "Token data not found in Zora API response" });
      return;
    }

    const name: string = token.name ?? "Unknown";
    const symbol: string = token.symbol ?? "?";
    const totalSupply: string = String(token.totalSupply ?? "0");

    // ── Price & Market Cap: read directly from Zora SDK API fields ────────
    //
    // tokenPrice.priceInPoolToken = price per token in the pool currency (ETH on Base).
    //   No conversion needed — this is already the ETH price.
    //
    // tokenPrice.priceInUsdc = price per token in USDC.
    //
    // marketCap = market cap expressed in USD (same unit as priceInUsdc).
    //   Convert to ETH: marketCap_usd * (priceInPoolToken / priceInUsdc)
    //   = marketCap * (ETH_per_token / USDC_per_token)
    //   = marketCap * (1 / ETH_price_in_USD)
    //   = marketCap_ETH
    let priceEth = "0";
    let mcEth = "0";

    const priceInPoolToken: string | undefined = token?.tokenPrice?.priceInPoolToken;
    const priceInUsdc: string | undefined = token?.tokenPrice?.priceInUsdc;
    const marketCapRaw: string | undefined = token?.marketCap;

    const pricePoolFloat = priceInPoolToken ? parseFloat(priceInPoolToken) : 0;
    const priceUsdcFloat = priceInUsdc ? parseFloat(priceInUsdc) : 0;

    let priceUsd = "0";
    let mcUsd = "0";

    if (pricePoolFloat > 0) {
      priceEth = pricePoolFloat.toFixed(18);
    }

    if (priceUsdcFloat > 0) {
      priceUsd = priceUsdcFloat.toFixed(8);
    }

    if (marketCapRaw) {
      const marketCapUsd = parseFloat(marketCapRaw);
      if (marketCapUsd > 0) {
        mcUsd = marketCapUsd.toFixed(2);
        if (pricePoolFloat > 0 && priceUsdcFloat > 0) {
          const ethPerDollar = pricePoolFloat / priceUsdcFloat;
          mcEth = (marketCapUsd * ethPerDollar).toFixed(6);
        }
      }
    }

    // ── Wallet balance (on-chain, optional) ──────────────────────────────
    let walletBalance = "0";
    try {
      const publicClient = makePublicClient();
      const account = privateKeyToAccount(getWalletKey());
      const rawBal = await publicClient.readContract({
        address: addr,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      walletBalance = formatUnits(rawBal, 18);
    } catch {
      /* no wallet configured or RPC unavailable */
    }

    res.json({ address: addr, name, symbol, totalSupply, walletBalance, priceEth, mcEth, priceUsd, mcUsd });
  } catch (err) {
    req.log.error({ err, address }, "Token info fetch failed");
    res.status(500).json({ error: "Failed to fetch token info" });
  }
});

// ── Open positions ─────────────────────────────────────────────────────────

router.get("/positions", async (_req, res): Promise<void> => {
  const openTrades = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.status, "confirmed"))
    .orderBy(desc(tradesTable.timestamp));

  if (openTrades.length === 0) {
    res.json([]);
    return;
  }

  const publicClient = makePublicClient();
  let walletAddress: Address;
  try {
    walletAddress = privateKeyToAccount(getWalletKey()).address;
  } catch {
    // Cannot check balances without a wallet — return error immediately.
    // Falling back to ZERO_ADDRESS would cause every position to read 0n
    // balance and get auto-closed as "sold externally" in the loop below.
    res.status(503).json({ error: "Wallet not configured (WALLET_PRIVATE_KEY not set)" });
    return;
  }

  const settled = await Promise.all(
    openTrades.map(async (trade: Trade) => {
      const addr = trade.tokenAddress as Address;

      let rawBal = 0n;
      try {
        rawBal = await publicClient.readContract({
          address: addr,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [walletAddress],
        });
      } catch {
        /* keep 0n */
      }

      // Balance is zero — position was closed externally (sold from wallet).
      if (rawBal === 0n) {
        await db
          .update(tradesTable)
          .set({ status: "sold", failReason: "closed externally — balance is 0" })
          .where(eq(tradesTable.id, trade.id));
        logger.info({ tradeId: trade.id, tokenAddress: trade.tokenAddress }, "Position auto-closed: balance 0 (external sell)");
        return null;
      }

      const currentBalanceTokens = formatUnits(rawBal, 18);
      const entryPriceEth = trade.entryPriceEth ?? "0";
      const entryPriceNum = parseFloat(entryPriceEth);
      const balNum = parseFloat(currentBalanceTokens);

      let currentValueUsdc = "0";
      let pnlPercent = 0;
      let priceUsd: string | null = null;
      let mcUsd: string | null = null;

      if (balNum > 0) {
        // ── Single Zora /coin API call: price + MC + est. value ───────────
        // fetchTokenMarketData returns both priceUsd and mcUsd in one request.
        // The frontend card uses these directly — no second /token/:address
        // call needed per position. Formula is the same as the TP/SL monitor.
        try {
          const marketData = await fetchTokenMarketData(addr);
          if (marketData !== null) {
            const valueUsdc = balNum * marketData.priceUsd;
            currentValueUsdc = valueUsdc.toFixed(6);
            priceUsd = marketData.priceUsd.toString();
            mcUsd = marketData.mcUsd > 0 ? marketData.mcUsd.toString() : null;
            const entryUsdc = trade.entryValueUsdc ? parseFloat(trade.entryValueUsdc) : null;
            if (entryUsdc && entryUsdc > 0) {
              pnlPercent = ((valueUsdc - entryUsdc) / entryUsdc) * 100;
            }
          }
        } catch {
          /* price unavailable — keep defaults */
        }
      }

      return { trade, currentBalanceTokens, entryPriceEth, currentValueUsdc, pnlPercent, priceUsd, mcUsd };
    }),
  );

  // Filter out positions that were auto-closed (null entries)
  const positions = settled.filter((p) => p !== null);

  res.json(positions);
});

// ── Market sell ────────────────────────────────────────────────────────────

router.post("/positions/:id/sell", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [trade] = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.id, id), eq(tradesTable.status, "confirmed")));

  if (!trade) { res.status(404).json({ error: "Position not found or already closed" }); return; }

  const addr = trade.tokenAddress as Address;
  const publicClient = makePublicClient();

  let walletAddress: Address;
  try {
    walletAddress = privateKeyToAccount(getWalletKey()).address;
  } catch {
    res.status(500).json({ error: "Wallet not configured" });
    return;
  }

  let rawBal: bigint;
  try {
    rawBal = await publicClient.readContract({
      address: addr,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });
  } catch {
    res.status(500).json({ error: "Failed to read token balance" });
    return;
  }

  if (rawBal === 0n) {
    res.status(400).json({ error: "No token balance to sell" });
    return;
  }

  // Fix: atomically claim the trade before selling — mirrors the same guard
  // used by the TP/SL monitor. Without this, a double-tap on "Sell Market"
  // (or this button racing the TP/SL monitor's own trigger) could start two
  // concurrent runMarketSell() calls for the same position: one succeeds via
  // 0x, the other's 0x attempt fails on the now-stale balance and falls back
  // to Li.Fi, burning an extra approval tx for a sell that never happens.
  const [claimed] = await db
    .update(tradesTable)
    .set({ status: "selling" })
    .where(and(eq(tradesTable.id, id), eq(tradesTable.status, "confirmed")))
    .returning();

  if (!claimed) {
    res.status(409).json({ error: "Sell already in progress for this position" });
    return;
  }

  // Respond immediately; sell executes in background
  res.status(202).json(claimed);

  // Unified sell path: 0x API (primary) → Li.Fi (fallback)
  // Same route for both sniper and manual positions.
  runMarketSell(claimed.id, addr, rawBal).catch((err) =>
    logger.error({ err, tradeId: claimed.id }, "Market sell background error"),
  );
});

// ── Update TP/SL ───────────────────────────────────────────────────────────

const UpdateTpSlBody = z.object({
  takeProfitPercent: z.number().min(0).max(10000).nullable().optional(),
  stopLossPercent: z.number().min(0).max(100).nullable().optional(),
});

router.put("/positions/:id/tpsl", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = UpdateTpSlBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input", details: parsed.error.issues }); return; }

  const [trade] = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.id, id), eq(tradesTable.status, "confirmed")));

  if (!trade) { res.status(404).json({ error: "Position not found or already closed" }); return; }

  const { takeProfitPercent, stopLossPercent } = parsed.data;

  const [updated] = await db
    .update(tradesTable)
    .set({
      takeProfitPercent: takeProfitPercent != null ? takeProfitPercent.toString() : null,
      stopLossPercent: stopLossPercent != null ? stopLossPercent.toString() : null,
    })
    .where(eq(tradesTable.id, id))
    .returning();

  res.json(updated);

  // Start/restart unified USD-based TP/SL monitor for all trades (sniper and manual)
  const entryValueUsdc = updated.entryValueUsdc ? parseFloat(updated.entryValueUsdc) : 0;
  if ((takeProfitPercent || stopLossPercent) && entryValueUsdc > 0) {
    loadConfig().then((config) =>
      monitorTpSlSniper(
        updated.id,
        updated.tokenAddress as Address,
        entryValueUsdc,
        takeProfitPercent ?? null,
        stopLossPercent ?? null,
        config.slippagePercent,
        config.maxGasGwei,
      )
    ).catch((err) => logger.error({ err, tradeId: updated.id }, "TP/SL monitor restart error"));
  } else if (takeProfitPercent || stopLossPercent) {
    logger.warn({ tradeId: updated.id }, "TP/SL monitor skipped on update — entryValueUsdc not available");
  }
});

// ── Manual trades list ─────────────────────────────────────────────────────

router.get("/manual/trades", async (req, res): Promise<void> => {
  const limitParam = req.query.limit;
  const limit = limitParam ? parseInt(String(limitParam), 10) : 20;

  const rows = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.source, "manual"))
    .orderBy(desc(tradesTable.timestamp))
    .limit(Math.min(limit, 100));

  res.json({ trades: rows });
});

// ── Trade status ─────────────────────────────────��─────────────────────────

router.get("/manual/status/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.id, id), eq(tradesTable.source, "manual")));

  if (!row) { res.status(404).json({ error: "Trade not found" }); return; }
  res.json(row);
});


// ── Startup recovery: restart TP/SL monitors for confirmed trades ──────────

/**
 * Called once at server startup. Finds all confirmed manual trades that
 * still have TP or SL set and restarts their in-memory monitors.
 * Without this, monitors die on every Railway redeploy/restart.
 */
export async function recoverTpSlMonitors(): Promise<void> {
  try {
    // Reset any trades stuck in "selling" — these were mid-sell when the server
    // crashed.  The sell tx may or may not have landed on-chain; the monitor
    // will re-read price/balance on the next poll cycle and retry if needed.
    const stuckCount = await db
      .update(tradesTable)
      .set({ status: "confirmed" })
      .where(
        and(
          eq(tradesTable.source, 'manual'),
          eq(tradesTable.status, 'selling'),
        ),
      );
    if ((stuckCount.rowCount ?? 0) > 0) {
      logger.warn(
        { count: stuckCount.rowCount },
        "TP/SL recovery: reset stuck 'selling' trades back to 'confirmed'",
      );
    }

    const openTrades = await db
      .select()
      .from(tradesTable)
      .where(
        and(
          eq(tradesTable.source, 'manual'),
          eq(tradesTable.status, 'confirmed'),
        ),
      );

    // Use the unified USD-based monitor (same as sniper). Requires entryValueUsdc.
    // Trades bought before this unification (entryValueUsdc = null) cannot be recovered
    // automatically — user can re-set TP/SL via the Edit button to restart the monitor.
    const recoverable = openTrades.filter(
      (t) => (t.takeProfitPercent || t.stopLossPercent) && t.entryValueUsdc,
    );

    if (recoverable.length === 0) {
      logger.info('TP/SL recovery: no active monitors to restart');
      return;
    }

    logger.info({ count: recoverable.length }, 'TP/SL recovery: restarting monitors');

    const config = await loadConfig();

    for (const trade of recoverable) {
      const entryValueUsdc = parseFloat(trade.entryValueUsdc!);
      const tp = trade.takeProfitPercent ? parseFloat(trade.takeProfitPercent) : null;
      const sl = trade.stopLossPercent ? parseFloat(trade.stopLossPercent) : null;

      monitorTpSlSniper(
        trade.id,
        trade.tokenAddress as Address,
        entryValueUsdc,
        tp,
        sl,
        config.slippagePercent,
        config.maxGasGwei,
      ).catch((err) =>
        logger.error({ err, tradeId: trade.id }, 'TP/SL recovery monitor error'),
      );

      logger.info({ tradeId: trade.id, token: trade.tokenAddress, tp, sl, entryValueUsdc }, 'TP/SL monitor recovered');
    }
  } catch (err) {
    logger.error({ err }, 'TP/SL recovery failed — monitors not restarted');
  }
}

export default router;
