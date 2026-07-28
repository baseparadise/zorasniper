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
import { getLiFiQuote, ensureApproval, ETH_ADDRESS, type LiFiQuoteResponse } from "../lib/lifi";
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

// Permit2 universal contract address (same on all EVM chains)
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

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

// Small ETH amount used as a price probe — never actually submitted as a tx.
const PROBE_ETH_WEI = parseEther("0.001");
const PROBE_AMOUNT_ETH = "0.001";

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
  /** Raw token amount out (string, 18 decimals) from the API response. May be
   *  undefined if the API does not include it in this version. */
  amountOut: string | null;
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
 * Mirrors fetchZoraPriceProbe from trader.ts.
 *
 * Strategy:
 * 1. Tiny buy quote (PROBE_ETH_WEI → token) — parse amountOut from response.
 * 2. Fallback: GET /coin endpoint for indexed price data.
 *
 * Returns null if the price cannot be determined (new pool, API issue, etc.).
 */
async function fetchZoraPriceProbe(tokenAddress: string, sender: string): Promise<number | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const _apiKey = nextZoraKey();
  if (_apiKey) headers["x-api-key"] = _apiKey;

  // ── Strategy 1: buy-direction quote probe ─────────────────────────────
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
  // We read balAfter at the confirmed block — reliable on any node (no archive needed).
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
    await db
      .update(tradesTable)
      .set({
        status: "confirmed",
        txHash,
        gasUsedEth,
        tokenAmount: tokenAmount || null,
        entryPriceEth: entryPriceStr,
        blockNumber: Number(receipt.blockNumber),
      })
      .where(eq(tradesTable.id, tradeId));

    logger.info({ tradeId, txHash, gasUsedEth, tokenAmount, entryPriceNum }, "Manual buy confirmed via Zora API");
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

    // Determine tokens received: check actual on-chain balance delta
    let tokenAmount = "0";
    try {
      const rawBal = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      const minOut = BigInt(estimate.toAmountMin);
      if (rawBal >= minOut && rawBal > 0n) {
        tokenAmount = formatUnits(BigInt(estimate.toAmount), 18);
      } else if (rawBal > 0n) {
        tokenAmount = formatUnits(rawBal, 18);
      } else if (minOut > 0n) {
        tokenAmount = formatUnits(minOut, 18);
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

    await db
      .update(tradesTable)
      .set({
        status: "confirmed",
        txHash: hash,
        gasUsedEth,
        tokenAmount,
        entryPriceEth: entryPriceStr,
        blockNumber: Number(receipt.blockNumber),
      })
      .where(eq(tradesTable.id, tradeId));

    logger.info({ tradeId, hash, gasUsedEth, tokenAmount, entryPriceNum }, "Manual buy confirmed via Li.Fi");
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

// ── TP/SL background monitor ───────────────────────────────────────────────

/**
 * Polls price every 15 s and triggers a sell when TP or SL is hit.
 *
 * Price probe strategy (mirrors the dual-path buy routing):
 *   1. Zora Quote API probe (same as sniper) — works for Zora Coins.
 *   2. Li.Fi quote probe — fallback for non-Zora tokens that used Li.Fi to buy.
 * If both probes return null in a cycle the cycle is skipped and retried.
 */
async function monitorTpSl(
  tradeId: number,
  tokenAddress: Address,
  entryPriceEth: number,
  takeProfitPercent: number | null,
  stopLossPercent: number | null,
  buyAmountEth: string,
): Promise<void> {
  if (!takeProfitPercent && !stopLossPercent) return;

  const publicClient = makePublicClient();

  let probeAccount: Address;
  try {
    probeAccount = privateKeyToAccount(getWalletKey()).address;
  } catch {
    probeAccount = ZERO_ADDRESS;
  }

  const tpPrice = takeProfitPercent ? entryPriceEth * (1 + takeProfitPercent / 100) : null;
  const slPrice = stopLossPercent ? entryPriceEth * (1 - stopLossPercent / 100) : null;

  logger.info({ tradeId, entryPriceEth, tpPrice, slPrice }, "Starting TP/SL monitor (Zora → Li.Fi)");

  const POLL_INTERVAL_MS = 15_000;
  const MAX_SELL_ATTEMPTS = 3;
  let sellAttempts = 0;
  let active = true;

  while (active) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    try {
      // Bail if trade was already closed externally (manual sell, etc.)
      const [trade] = await db
        .select({ status: tradesTable.status })
        .from(tradesTable)
        .where(eq(tradesTable.id, tradeId));

      if (!trade || trade.status !== "confirmed") {
        logger.info({ tradeId, status: trade?.status }, "TP/SL monitor: trade no longer active — exiting");
        return;
      }

      // ── Price probe: Zora first, Li.Fi fallback ──────────────────────────
      let currentPrice: number | null = null;

      // 1. Try Zora price probe (works for Zora Coins, new or established)
      const zoraPrice = await fetchZoraPriceProbe(tokenAddress, probeAccount);
      if (zoraPrice !== null) {
        currentPrice = zoraPrice;
      } else {
        // 2. Li.Fi fallback probe (for tokens bought via Li.Fi)
        try {
          const probeQuote = await getLiFiQuote(
            ETH_ADDRESS,
            tokenAddress,
            parseEther(PROBE_AMOUNT_ETH),
            probeAccount,
            5,
          );
          const probeTokens = parseFloat(formatUnits(BigInt(probeQuote.estimate.toAmount), 18));
          if (probeTokens > 0) {
            currentPrice = parseFloat(PROBE_AMOUNT_ETH) / probeTokens;
          }
        } catch {
          // Both APIs unavailable — skip this cycle
        }
      }

      if (currentPrice === null) continue;

      logger.debug({ tradeId, currentPrice, tpPrice, slPrice }, "TP/SL price check");

      const shouldTp = tpPrice !== null && currentPrice >= tpPrice;
      const shouldSl = slPrice !== null && currentPrice <= slPrice;

      if (!shouldTp && !shouldSl) continue;

      const reason = shouldTp ? "take_profit" : "stop_loss";
      logger.info({ tradeId, reason, currentPrice, tpPrice, slPrice }, "TP/SL triggered, executing sell");

      // Stop the loop unless the sell fails and we need to retry
      active = false;

      const rawBal = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [probeAccount],
      });

      if (rawBal === 0n) {
        logger.warn({ tradeId }, "No token balance to sell — position already closed externally");
        await db
          .update(tradesTable)
          .set({ status: "sold", failReason: "Balance zero at TP/SL trigger" })
          .where(eq(tradesTable.id, tradeId));
        return;
      }

      // ── Try Zora first, fallback to Li.Fi ──────────────────────────────
      try {
        await runZoraSell(tradeId, tokenAddress, rawBal, buyAmountEth);
        logger.info({ tradeId, reason }, "TP/SL sell confirmed via Zora");
      } catch (zoraErr) {
        const zoraMsg = (zoraErr instanceof Error ? zoraErr.message : String(zoraErr)).slice(0, 200);
        logger.warn({ tradeId, zoraMsg }, "TP/SL: Zora sell failed — falling back to Li.Fi");
        await runLiFiSell(tradeId, tokenAddress, rawBal, buyAmountEth, 10);
        logger.info({ tradeId, reason }, "TP/SL sell confirmed via Li.Fi");
      }
    } catch (err) {
      // If this was a sell attempt that failed, count it and maybe retry
      if (!active) {
        sellAttempts++;
        logger.error({ err, tradeId, sellAttempts, maxAttempts: MAX_SELL_ATTEMPTS }, "TP/SL sell failed");
        if (sellAttempts >= MAX_SELL_ATTEMPTS) {
          logger.error({ tradeId }, "Max sell attempts reached — monitor exiting");
          return;
        }
        // Re-activate to retry sell on next poll cycle
        active = true;
      } else {
        // Error in price probe or DB query — log and continue polling
        logger.error({ err, tradeId }, "TP/SL monitor cycle error");
      }
    }
  }
}

// ── Market sell helpers ───────────────────────────────────────────────────

/**
 * Sell tokens via Li.Fi (token → ETH swap through the best available DEX route).
 * Throws on any failure so the caller can handle the error.
 */
async function runLiFiSell(
  tradeId: number,
  tokenAddress: Address,
  rawBal: bigint,
  buyAmountEth: string,
  slippagePercent: number = 10,
): Promise<void> {
  const publicClient = makePublicClient();
  const account = privateKeyToAccount(getWalletKey());
  const walletClient = createWalletClient({ account, chain: base, transport: http(getHttpRpcUrl()) });

  const sellQuote = await getLiFiQuote(
    tokenAddress,
    ETH_ADDRESS,
    rawBal,
    account.address,
    slippagePercent,
  );

  // NOTE: pass full `account` object (not account.address) so viem can sign the approval tx
  if (sellQuote.estimate.approvalAddress) {
    await ensureApproval(
      publicClient,
      walletClient,
      account,
      tokenAddress,
      sellQuote.estimate.approvalAddress as Address,
      rawBal,
    );
  }

  // ── EIP-1559 gas — explicit fees to prevent Alchemy "invalid params" error ──
  const { transactionRequest: sellTx } = sellQuote;
  let liFiMaxFeePerGas: bigint | undefined;
  let liFiMaxPriorityFeePerGas: bigint | undefined;
  try {
    const fees = await publicClient.estimateFeesPerGas();
    liFiMaxFeePerGas = fees.maxFeePerGas;
    liFiMaxPriorityFeePerGas = fees.maxPriorityFeePerGas < fees.maxFeePerGas
      ? fees.maxPriorityFeePerGas
      : fees.maxFeePerGas;
  } catch { /* let viem fall back to its own estimation */ }

  const hash = await walletClient.sendTransaction({
    to: sellTx.to as Address,
    data: sellTx.data as `0x${string}`,
    value: BigInt(sellTx.value || "0"),
    gas: sellTx.gasLimit ? BigInt(sellTx.gasLimit) : undefined,
    maxFeePerGas: liFiMaxFeePerGas,
    maxPriorityFeePerGas: liFiMaxPriorityFeePerGas,
    account,
    chain: base,
  });

  logger.info({ tradeId, hash }, "Li.Fi sell tx submitted");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== "success") {
    throw new Error("Li.Fi sell tx reverted on-chain");
  }

  const ethRecovered = sellQuote.estimate.toAmountMin
    ? formatEther(BigInt(sellQuote.estimate.toAmountMin))
    : "0";
  const pnl = (parseFloat(ethRecovered) - parseFloat(buyAmountEth)).toFixed(6);

  await db
    .update(tradesTable)
    .set({ status: "sold", sellTxHash: hash, sellAmountEth: ethRecovered, pnlEth: pnl })
    .where(eq(tradesTable.id, tradeId));

  logger.info({ tradeId, pnl, ethRecovered, hash }, "Market sell confirmed via Li.Fi");
}

/**
 * Sell tokens via Zora Quote API (token → USDC), identical to sniper logic.
 * USDC routing is more reliable than ETH for Zora Coins whose pools pair
 * against a creator coin rather than WETH directly.
 * Uses the same EIP-1559 gas handling as the Zora buy path.
 *
 * The Zora API returns sell calldata with a Permit2 EIP-712 placeholder
 * ("REPLACE_WITH_PERMIT_SIGNATURE_1") that must be signed and injected before
 * the tx is submitted. This function handles that automatically.
 *
 * Throws on any failure so the caller can fall back to Li.Fi.
 */
async function runZoraSell(
  tradeId: number,
  tokenAddress: Address,
  rawBal: bigint,
  buyAmountEth: string,
): Promise<void> {
  const account = privateKeyToAccount(getWalletKey());
  const httpUrl = getHttpRpcUrl();
  const publicClient = createPublicClient({ chain: base, transport: http(httpUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(httpUrl) });

  // Load config for gas cap — sensible default if config unavailable
  let maxGasGwei = 10;
  try {
    const config = await loadConfig();
    maxGasGwei = config.maxGasGwei;
  } catch { /* proceed with default */ }

  // ── Snapshot USDC balance before sell (same as sniper) ───────────────────
  const usdcBefore = await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  // ── Fetch Zora sell quote: token → USDC (with retry, same as sniper) ─────
  const _apiKey = nextZoraKey();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (_apiKey) headers["x-api-key"] = _apiKey;

  const quoteBody = JSON.stringify({
    chainId: base.id,
    tokenIn: { type: "erc20", address: tokenAddress.toLowerCase() },
    tokenOut: { type: "erc20", address: USDC_BASE.toLowerCase() },
    amountIn: rawBal.toString(),
    slippage: 0.1, // 10% for sells
    sender: account.address.toLowerCase(),
    recipient: account.address.toLowerCase(),
  });

  let rawCall: ZoraCall | null = null;
  let permits: ZoraPermit[] = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${ZORA_QUOTE_API}/quote`, { method: "POST", headers, body: quoteBody });
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
        logger.warn({ tradeId, attempt, status: res.status, body: text.slice(0, 100) }, "Zora sell quote failed, retry in 5s");
        await new Promise(r => setTimeout(r, 5_000));
        continue;
      }
      throw new Error(`Zora sell quote HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.call) {
      // API returned 200 but with an error payload — treat as no-route
      if (data.success === false || data.success === "false" || data.error) {
        throw new Error(`ZoraNoRoute: ${JSON.stringify(data).slice(0, 200)}`);
      }
      if (attempt < 3) {
        logger.warn({ tradeId, attempt, data }, "Zora sell quote: no call field, retry in 5s");
        await new Promise(r => setTimeout(r, 5_000));
        continue;
      }
      throw new Error(`Zora sell quote returned no call: ${JSON.stringify(data).slice(0, 200)}`);
    }
    // Guard: amountOut "0" means the route has no liquidity (e.g. token pools against a
    // creator coin rather than WETH/USDC). Throw so the caller falls back to Li.Fi.
    const amountOut: string | null = data.quote?.amountOut ?? null;
    if (amountOut === "0") {
      logger.warn({ tradeId, amountOut }, "Zora sell quote: amountOut is 0 — no liquidity, falling back");
      throw new Error("ZoraNoRoute: amountOut is 0 (pool has no liquidity for this route)");
    }

    rawCall = data.call as ZoraCall;
    permits = Array.isArray(data.permits) ? data.permits : [];
    logger.info({ tradeId, amountOut }, "Zora sell quote amountOut ok");
    break;
  }

  if (!rawCall) throw new Error("Zora sell quote failed after 3 attempts");

  logger.info({ tradeId, target: rawCall.target, permitsCount: permits.length }, "Zora sell quote OK");

  // ── Handle Permit2 if the API returned permit data ────────────────────────
  //
  // The Zora API builds sell calldata using Permit2. When permits are returned,
  // `call.data` contains "REPLACE_WITH_PERMIT_SIGNATURE_1" which must be replaced
  // with a signed EIP-712 Permit2 message. Approval goes to Permit2, not the router.
  let call = rawCall;

  if (permits.length > 0) {
    logger.info({ tradeId, permitsCount: permits.length }, "Signing Permit2 for Zora sell");

    // Approve Permit2 contract to spend tokens (if not already sufficient)
    const permit2Allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, PERMIT2_ADDRESS],
    });
    if (permit2Allowance < rawBal) {
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

    // Sign each permit and inject signature into calldata
    let callData = rawCall.data;
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
      callData = injectPermitSignature(callData, sig);
      logger.info({ tradeId, sigLength: sig.length }, "Permit2 signature injected into calldata");
    }
    call = { ...rawCall, data: callData };
  } else {
    // No permits — use traditional approve(router, maxUint256) path
    const routerAddress = toHex(rawCall.target) as Address;
    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, routerAddress],
    });
    if (allowance < rawBal) {
      logger.info({ tradeId, spender: routerAddress }, "Approving Zora router for sell");
      const approveTx = await walletClient.writeContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [routerAddress, maxUint256],
        chain: base,
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
      logger.info({ tradeId, approveTx }, "Zora sell approval confirmed");
    }
  }

  const routerAddress = toHex(call.target) as Address;

  // ── Simulate (warning-only — Zora router can revert in eth_call) ─────────
  try {
    await publicClient.call({
      to: routerAddress,
      data: toHex(call.data),
      value: toBigIntSafe(call.value),
      account: account.address,
    });
    logger.info({ tradeId }, "Zora sell simulation passed");
  } catch (simErr) {
    const msg = simErr instanceof Error ? simErr.message.slice(0, 200) : String(simErr);
    logger.warn({ tradeId, msg }, "Zora sell simulation warning — proceeding");
  }

  // ── EIP-1559 gas with cap ─────────────────────────────────────────────────
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
    logger.warn({ tradeId, err: gasErr }, "Zora sell gas estimation failed — using 500k fallback");
    feeEstimate = await publicClient.estimateFeesPerGas();
    estimatedGas = 500_000n;
  }
  const maxFeePerGas = feeEstimate.maxFeePerGas < maxFeeCapWei
    ? feeEstimate.maxFeePerGas
    : maxFeeCapWei;
  const maxPriorityFeePerGas = feeEstimate.maxPriorityFeePerGas < maxFeePerGas
    ? feeEstimate.maxPriorityFeePerGas
    : maxFeePerGas;
  const gasLimit = (estimatedGas * 120n) / 100n;

  logger.info(
    { tradeId, estimatedGas: estimatedGas.toString(), maxFeePerGas: maxFeePerGas.toString() },
    "Zora sell: gas estimated",
  );

  // ── Send tx ───────────────────────────────────────────────────────────────
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

  logger.info({ tradeId, txHash }, "Zora sell tx submitted");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });

  if (receipt.status !== "success") {
    throw new Error(`Zora sell tx reverted on-chain: ${txHash}`);
  }

  const gasUsedEth = formatEther(receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas));

  // ── Calculate USDC received via balance diff (same as sniper) ────────────
  const usdcAfter = await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  const usdcReceived = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n;
  // sellAmountEth stores USDC received (6 decimals) — same convention as sniper
  const sellAmountUsdc = formatUnits(usdcReceived, USDC_DECIMALS);

  await db
    .update(tradesTable)
    .set({ status: "sold", sellTxHash: txHash, sellAmountEth: sellAmountUsdc, pnlEth: sellAmountUsdc })
    .where(eq(tradesTable.id, tradeId));

  logger.info({ tradeId, sellAmountUsdc, gasUsedEth, txHash }, "Zora sell confirmed (token → USDC)");
}

/**
 * Executes an immediate market sell: tries Zora API first (token → USDC,
 * same as sniper), falls back to Li.Fi if Zora fails for any reason.
 * Updates the trade record to "sold" on success, "confirmed" (with failReason) on total failure.
 */
async function runMarketSell(
  tradeId: number,
  tokenAddress: Address,
  rawBal: bigint,
  buyAmountEth: string,
): Promise<void> {
  // ── Try Zora first (consistent with buy path) ─────────────────────────────
  try {
    await runZoraSell(tradeId, tokenAddress, rawBal, buyAmountEth);
    return;
  } catch (zoraErr) {
    const zoraMsg = (zoraErr instanceof Error ? zoraErr.message : String(zoraErr)).slice(0, 200);
    logger.warn({ tradeId, zoraMsg }, "Zora sell failed — falling back to Li.Fi");
  }

  // ── Li.Fi fallback ────────────────────────────────────────────────────────
  try {
    await runLiFiSell(tradeId, tokenAddress, rawBal, buyAmountEth);
  } catch (err) {
    const failReason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    logger.error({ err, tradeId, failReason }, "Market sell via Li.Fi also failed");
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

    // 1. Try Zora price probe (exact same logic as sniper)
    const zoraPrice = await fetchZoraPriceProbe(addr, probeAccount);
    if (zoraPrice !== null) {
      entryPriceEth = zoraPrice;
    } else {
      // 2. Li.Fi fallback probe
      const probeQuote = await getLiFiQuote(
        ETH_ADDRESS,
        addr,
        parseEther("0.0001"),
        probeAccount,
        slippagePercent,
      );
      const probeTokens = parseFloat(formatUnits(BigInt(probeQuote.estimate.toAmount), 18));
      if (probeTokens > 0) entryPriceEth = 0.0001 / probeTokens;
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

  runBuy(tradeRow.id, addr, buyAmountEth, slippagePercent).then((actualEntryPrice) => {
    const monitorEntryPrice = actualEntryPrice > 0 ? actualEntryPrice : entryPriceEth;
    if ((takeProfitPercent || stopLossPercent) && monitorEntryPrice > 0) {
      monitorTpSl(
        tradeRow.id,
        addr,
        monitorEntryPrice,
        takeProfitPercent ?? null,
        stopLossPercent ?? null,
        buyAmountEth,
      ).catch(err => logger.error({ err, tradeId: tradeRow.id }, "TP/SL monitor error"));
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
  const publicClient = makePublicClient();

  try {
    const [name, symbol, totalSupply] = await Promise.all([
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" }),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "totalSupply" }),
    ]);

    let walletBalance = "0";
    try {
      const account = privateKeyToAccount(getWalletKey());
      const rawBal = await publicClient.readContract({
        address: addr,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      walletBalance = formatUnits(rawBal, 18);
    } catch {
      /* no wallet configured */
    }

    // ── Price estimation: Zora first, Li.Fi fallback ────────────────────
    let priceEth = "0";
    let mcEth = "0";
    try {
      let probeAccount: Address;
      try { probeAccount = privateKeyToAccount(getWalletKey()).address; } catch { probeAccount = ZERO_ADDRESS; }

      // 1. Try Zora price probe
      const zoraPrice = await fetchZoraPriceProbe(addr, probeAccount);
      if (zoraPrice !== null) {
        priceEth = zoraPrice.toFixed(18);
        const mcNum = parseFloat(formatUnits(totalSupply as bigint, 18)) * zoraPrice;
        mcEth = mcNum.toFixed(6);
      } else {
        // 2. Li.Fi fallback probe
        const probeQuote = await getLiFiQuote(
          ETH_ADDRESS,
          addr,
          parseEther("0.0001"),
          probeAccount,
          5,
        );
        const probeTokens = parseFloat(formatUnits(BigInt(probeQuote.estimate.toAmount), 18));
        if (probeTokens > 0) {
          const priceNum = 0.0001 / probeTokens;
          priceEth = priceNum.toFixed(18);
          const mcNum = parseFloat(formatUnits(totalSupply as bigint, 18)) * priceNum;
          mcEth = mcNum.toFixed(6);
        }
      }
    } catch {
      /* pool not yet active or no route available */
    }

    res.json({ address: addr, name, symbol, totalSupply: formatUnits(totalSupply as bigint, 18), walletBalance, priceEth, mcEth });
  } catch (err) {
    req.log.error({ err, address }, "Token info fetch failed");
    res.status(500).json({ error: "Failed to fetch token info from chain" });
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
    walletAddress = ZERO_ADDRESS;
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

      let currentValueEth = "0";
      let pnlPercent = 0;

      if (balNum > 0 && entryPriceNum > 0) {
        // ── Price probe: Zora first, Li.Fi fallback ──────────────────────
        try {
          let currentPrice: number | null = null;

          const zoraPrice = await fetchZoraPriceProbe(addr, walletAddress);
          if (zoraPrice !== null) {
            currentPrice = zoraPrice;
          } else {
            const probeQuote = await getLiFiQuote(
              ETH_ADDRESS,
              addr,
              parseEther("0.0001"),
              walletAddress,
              5,
            );
            const probeTokens = parseFloat(formatUnits(BigInt(probeQuote.estimate.toAmount), 18));
            if (probeTokens > 0) {
              currentPrice = 0.0001 / probeTokens;
            }
          }

          if (currentPrice !== null) {
            const currentValue = balNum * currentPrice;
            currentValueEth = currentValue.toFixed(6);
            const buyEth = parseFloat(trade.buyAmountEth ?? "0");
            pnlPercent = buyEth > 0 ? ((currentValue - buyEth) / buyEth) * 100 : 0;
          }
        } catch {
          /* price unavailable — keep defaults */
        }
      }

      return { trade, currentBalanceTokens, entryPriceEth, currentValueEth, pnlPercent };
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

  // Respond immediately; sell executes in background
  res.status(202).json(trade);

  // Route sell to correct DEX: sniper positions use Zora API; manual positions use Li.Fi
  if (trade.source === "sniper") {
    loadConfig().then((config) =>
      executeZoraSell({
        tradeId: trade.id,
        tokenAddress: addr,
        tokenBalance: rawBal,
        slippagePercent: config.slippagePercent,
        maxGasGwei: config.maxGasGwei,
        reason: "manual_sell",
      })
    ).catch((err) => logger.error({ err, tradeId: trade.id }, "Sniper market sell background error"));
  } else {
    runMarketSell(trade.id, addr, rawBal, trade.buyAmountEth ?? "0").catch((err) =>
      logger.error({ err, tradeId: trade.id }, "Market sell background error"),
    );
  }
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

  // Start/restart TP/SL monitor — sniper uses Zora API monitor, manual uses dual-path monitor
  const entryPrice = updated.entryPriceEth ? parseFloat(updated.entryPriceEth) : 0;
  if ((takeProfitPercent || stopLossPercent) && entryPrice > 0) {
    if (updated.source === "sniper") {
      loadConfig().then((config) =>
        monitorTpSlSniper(
          updated.id,
          updated.tokenAddress as Address,
          entryPrice,
          takeProfitPercent ?? null,
          stopLossPercent ?? null,
          config.slippagePercent,
          config.maxGasGwei,
        )
      ).catch((err) => logger.error({ err, tradeId: updated.id }, "Sniper TP/SL monitor restart error"));
    } else {
      monitorTpSl(
        updated.id,
        updated.tokenAddress as Address,
        entryPrice,
        takeProfitPercent ?? null,
        stopLossPercent ?? null,
        updated.buyAmountEth ?? "0",
      ).catch((err) => logger.error({ err, tradeId: updated.id }, "TP/SL monitor restart error"));
    }
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
    const openTrades = await db
      .select()
      .from(tradesTable)
      .where(
        and(
          eq(tradesTable.source, 'manual'),
          eq(tradesTable.status, 'confirmed'),
        ),
      );

    const recoverable = openTrades.filter(
      (t) => (t.takeProfitPercent || t.stopLossPercent) && t.entryPriceEth,
    );

    if (recoverable.length === 0) {
      logger.info('TP/SL recovery: no active monitors to restart');
      return;
    }

    logger.info({ count: recoverable.length }, 'TP/SL recovery: restarting monitors');

    for (const trade of recoverable) {
      const entryPrice = parseFloat(trade.entryPriceEth!);
      const tp = trade.takeProfitPercent ? parseFloat(trade.takeProfitPercent) : null;
      const sl = trade.stopLossPercent ? parseFloat(trade.stopLossPercent) : null;

      monitorTpSl(
        trade.id,
        trade.tokenAddress as Address,
        entryPrice,
        tp,
        sl,
        trade.buyAmountEth ?? '0',
      ).catch((err) =>
        logger.error({ err, tradeId: trade.id }, 'TP/SL recovery monitor error'),
      );

      logger.info({ tradeId: trade.id, token: trade.tokenAddress, tp, sl }, 'TP/SL monitor recovered');
    }
  } catch (err) {
    logger.error({ err }, 'TP/SL recovery failed — monitors not restarted');
  }
}

export default router;
