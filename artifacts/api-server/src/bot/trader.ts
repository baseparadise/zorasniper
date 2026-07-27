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
  const apiKey = process.env.ZORA_API_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

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

/**
 * Fetch a SELL quote from Zora Quote API (erc20 → ETH).
 * Used exclusively by the sniper TP/SL monitor.
 */
async function fetchZoraSellQuote(params: {
  tokenAddress: string;
  tokenAmountWei: bigint;
  slippage: number; // fractional
  sender: string;
}): Promise<ZoraCall> {
  const apiKey = process.env.ZORA_API_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const body = JSON.stringify({
    chainId: base.id,
    tokenIn: { type: "erc20", address: params.tokenAddress.toLowerCase() },
    tokenOut: { type: "eth" },
    amountIn: params.tokenAmountWei.toString(),
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
      if (attempt < 3) {
        logger.warn(
          { attempt, status: res.status, body: text.slice(0, 100) },
          `Zora sell quote attempt ${attempt}/3 failed, retry in 5s`,
        );
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw new Error(`Zora sell quote HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!data.call) {
      if (attempt < 3) {
        logger.warn({ attempt, data }, `Zora sell quote attempt ${attempt}/3 — no call, retry in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw new Error(`Zora sell quote returned no call: ${JSON.stringify(data).slice(0, 200)}`);
    }

    logger.info({ attempt, target: data.call.target }, "Zora sell quote OK");
    return data.call as ZoraCall;
  }

  throw new Error("Zora sell quote failed after 3 attempts");
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
  const apiKey = process.env.ZORA_API_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

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
 */
async function executeZoraSell(params: {
  tradeId: number;
  tokenAddress: Address;
  tokenBalance: bigint;
  slippagePercent: number;
  maxGasGwei: number;
  reason: string;
}): Promise<void> {
  const { tradeId, tokenAddress, tokenBalance, slippagePercent, maxGasGwei, reason } = params;
  const account = privateKeyToAccount(getWalletKey());
  const httpUrl = getHttpRpcUrl();
  const publicClient = createPublicClient({ chain: base, transport: http(httpUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(httpUrl) });

  // ── Step 1: Get sell quote ────────────────────────────────────────────────
  const call = await fetchZoraSellQuote({
    tokenAddress,
    tokenAmountWei: tokenBalance,
    slippage: slippagePercent / 100,
    sender: account.address,
  });

  // ── Step 2: Approve Zora router if allowance is insufficient ──────────────
  const allowance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, call.target as Address],
  });

  if (allowance < tokenBalance) {
    logger.info({ tradeId, spender: call.target }, "Approving Zora router for token sell");
    const approveTx = await walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [call.target as Address, maxUint256],
      chain: base,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
    logger.info({ tradeId, approveTx }, "Sell approval confirmed");
  }

  // ── Step 3: Simulate sell ─────────────────────────────────────────────────
  try {
    await publicClient.call({
      to: call.target as Address,
      data: call.data as `0x${string}`,
      value: BigInt(call.value),
      account: account.address,
    });
    logger.info({ tradeId }, "Sell simulation passed");
  } catch (simErr) {
    const msg = simErr instanceof Error ? simErr.message.slice(0, 200) : String(simErr);
    throw new Error(`Sell simulation reverted — aborting: ${msg}`);
  }

  // ── Step 4: Gas estimation ────────────────────────────────────────────────
  const maxFeeCapWei = BigInt(Math.round(maxGasGwei * 1e9));
  const [feeEstimate, estimatedGas] = await Promise.all([
    publicClient.estimateFeesPerGas(),
    publicClient.estimateGas({
      to: call.target as Address,
      data: call.data as `0x${string}`,
      value: BigInt(call.value),
      account: account.address,
    }),
  ]);
  const maxFeePerGas =
    feeEstimate.maxFeePerGas < maxFeeCapWei ? feeEstimate.maxFeePerGas : maxFeeCapWei;
  const maxPriorityFeePerGas =
    feeEstimate.maxPriorityFeePerGas < maxFeePerGas
      ? feeEstimate.maxPriorityFeePerGas
      : maxFeePerGas;
  const gasLimit = (estimatedGas * 120n) / 100n;

  // ── Step 5: Capture ETH balance before send ───────────────────────────────
  const ethBefore = await publicClient.getBalance({ address: account.address });

  // ── Step 6: Send sell tx ──────────────────────────────────────────────────
  const txHash = await walletClient.sendTransaction({
    to: call.target as Address,
    data: call.data as `0x${string}`,
    value: BigInt(call.value),
    chain: base,
    account,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  logger.info({ tradeId, txHash, reason }, "Sniper sell tx submitted via Zora API");

  // ── Step 7: Wait for receipt ──────────────────────────────────────────────
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });

  if (receipt.status !== "success") {
    throw new Error("Sniper sell tx reverted on-chain");
  }

  // ── Step 8: Calculate ETH received (net of gas) ───────────────────────────
  const ethAfter = await publicClient.getBalance({ address: account.address });
  const gasSpent = receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas);
  const ethReceivedGross = ethAfter - ethBefore + gasSpent;
  const sellAmountEth = formatEther(ethReceivedGross > 0n ? ethReceivedGross : 0n);

  // P&L vs original buy amount
  const [tradeRow] = await db.select().from(tradesTable).where(eq(tradesTable.id, tradeId));
  const buyAmount = parseFloat(tradeRow?.buyAmountEth ?? "0");
  const pnlEth = (parseFloat(sellAmountEth) - buyAmount).toFixed(8);

  const [updated] = await db
    .update(tradesTable)
    .set({ status: "sold", sellTxHash: txHash, sellAmountEth, pnlEth })
    .where(eq(tradesTable.id, tradeId))
    .returning();

  broadcast("trade", updated);
  logger.info({ tradeId, txHash, sellAmountEth, pnlEth, reason }, "Sniper sell confirmed via Zora API");
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

    const value = BigInt(call.value);

    // ── Step 2: Simulate — revert early before spending gas ───────────────────
    try {
      await publicClient.call({
        to: call.target as Address,
        data: call.data as `0x${string}`,
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
        to: call.target as Address,
        data: call.data as `0x${string}`,
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
      to: call.target as Address,
      data: call.data as `0x${string}`,
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
        tokenAmount = received.toString();
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
