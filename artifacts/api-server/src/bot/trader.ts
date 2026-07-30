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
import { get0xSellQuote, ZEROX_NATIVE_ETH } from "../lib/zerox";
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

// USDC address on Base used for sell-direction value probes in the TP/SL monitor
// (defined early so fetchCurrentValueUsdc can reference it before USDC_BASE below)

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
    // Extract as much detail as possible from viem simulation errors.
    // viem stores the real revert reason in .cause.reason (ABI-decoded) or
    // .cause.data (raw bytes) — .message alone is often just the formatted wrapper.
    const simMsg = simErr instanceof Error ? simErr.message.slice(0, 300) : String(simErr);
    const simShort = String((simErr as any)?.shortMessage ?? "");
    const simDetails = String((simErr as any)?.details ?? "");
    const causeReason = String((simErr as any)?.cause?.reason ?? "");
    const causeData = String((simErr as any)?.cause?.data ?? "");
    logger.warn(
      { ...logCtx, simMsg, simShort, simDetails, causeReason, causeData },
      "Swap simulation warning — tx will likely revert on-chain (proceeding to gas check)",
    );
  }

  // Gas estimation with fallback
  // IMPORTANT: if estimateGas itself reverts (EstimateGasExecutionError / execution reverted),
  // that means the tx body is bad (invalid signature, slippage exceeded, etc.) and WILL revert
  // on-chain. Do NOT waste gas — throw immediately so the caller can fall back to Li.Fi.
  // Only use the 500k fallback for node/network-level errors (timeout, RPC unavailable, etc.).
  // maxGasGwei kept as param for backward compat but no longer used as a hard cap.
  // Gas price is fully automatic: use whatever the network estimates.
  // Base fees are consistently cheap (< 0.01 gwei) so no cap is needed.
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
  // Use network-estimated fee directly — no manual cap.
  const maxFeePerGas = feeEstimate.maxFeePerGas;
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
 * Fetch the current market price of a token in USDC via the Zora /coin endpoint.
 *
 * Parses the same JSON fields as fetchTokenMarketData in manual.ts so the
 * TP/SL monitor and the /positions card always read price from the same source:
 *   data.coin ?? data.zora20Token  (tries "coin" key first, falls back to "zora20Token")
 *   token.tokenPrice.priceInUsdc  (primary)  OR  token.price  (fallback)
 *
 * Previously only read data.zora20Token — if the API returned "coin" the monitor
 * returned null and TP/SL never triggered while the card still showed a price.
 *
 * Returns null if the token is not yet indexed or the API cannot return a price.
 * Expected for very new tokens (< few blocks old); caller should skip and retry.
 */
async function fetchTokenPriceUsdc(tokenAddress: string): Promise<number | null> {
  try {
    const headers: Record<string, string> = {};
    const _apiKey = nextZoraKey();
    if (_apiKey) headers["x-api-key"] = _apiKey;

    const res = await fetch(
      `${ZORA_QUOTE_API}/coin?chainId=${base.id}&address=${tokenAddress.toLowerCase()}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );

    if (res.ok) {
      const data = await res.json();
      // Try "coin" key first (newer API shape), fall back to "zora20Token" (older shape).
      // Mirrors the parsing logic in manual.ts fetchTokenMarketData so both paths
      // read from the same field and can never diverge on the same API response.
      const token = data?.coin ?? data?.zora20Token;
      const priceInUsdc: string | undefined =
        token?.tokenPrice?.priceInUsdc ?? token?.price;
      if (priceInUsdc) {
        const price = parseFloat(priceInUsdc);
        if (price > 0) return price;
      }
    }
  } catch (err) {
    logger.warn({ err, tokenAddress }, "fetchTokenPriceUsdc: /coin endpoint failed");
  }

  return null;
}

/**
 * Compute the current USDC value of a token position via price × balance.
 *
 * Formula: (tokenBalanceWei / 1e18) × pricePerTokenUsdc
 *
 * Why price × balance instead of a sell quote:
 * - Sell quote for the FULL balance simulates selling all tokens at once, which
 *   crashes the price in thin Zora pools → reported value is far below the real
 *   market value of the position.
 * - price × balance uses the market price per token (from the Zora /coin API),
 *   which is what the position is actually worth at current market conditions,
 *   consistent with how the price is displayed in the UI.
 *
 * Returns null if the price cannot be determined; caller should skip and retry.
 */
async function fetchPositionValueUsdc(
  tokenAddress: string,
  tokenBalanceWei: bigint,
): Promise<number | null> {
  if (tokenBalanceWei === 0n) return 0;

  const priceUsdc = await fetchTokenPriceUsdc(tokenAddress);
  if (priceUsdc === null) return null;

  const tokenAmount = parseFloat(formatUnits(tokenBalanceWei, 18));
  return tokenAmount * priceUsdc;
}

/**
 * Sell a token position.
 * Primary:  0x API v2 Permit2 (token → ETH via best available DEX route).
 * Fallback: Li.Fi (token → ETH) if 0x API cannot find a route or fails.
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
    await execute0xSellTrade(params);
    return;
  } catch (zeroxErr) {
    const msg = zeroxErr instanceof Error ? zeroxErr.message : String(zeroxErr);
    logger.warn({ tradeId: params.tradeId, err: msg }, "0x API sell failed — falling back to Li.Fi");
  }
  await executeLiFiSell(params);
}

/**
 * Execute a sell via 0x API v2 (Permit2).
 * Handles ERC-20 approval (Permit2 or AllowanceHolder path), EIP-712
 * signature injection, gas estimation, tx submission, receipt, and
 * DB update. Throws on any failure so the caller can fall back to Li.Fi.
 */
async function execute0xSellTrade(params: {
  tradeId: number;
  tokenAddress: Address;
  tokenBalance: bigint;
  slippagePercent: number;
  maxGasGwei: number;
  reason: string;
}): Promise<void> {
  const { tradeId, tokenAddress, tokenBalance, slippagePercent, reason } = params;
  const slippageBps = Math.round(slippagePercent * 100); // e.g. 5% → 500 bps

  const account = privateKeyToAccount(getWalletKey());
  const httpUrl = getHttpRpcUrl();
  const publicClient = createPublicClient({ chain: base, transport: http(httpUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(httpUrl) });

  const logCtx = { tradeId, reason, method: "0x" };
  logger.info(logCtx, "execute0xSellTrade: fetching 0x quote");

  // ── Get 0x quote (token → ETH) ───────────────────────────────────────────
  const quote = await get0xSellQuote({
    sellToken: tokenAddress,
    buyToken: ZEROX_NATIVE_ETH,
    sellAmount: tokenBalance,
    taker: account.address,
    slippageBps,
  });

  const tx = quote.transaction;
  let txData: `0x${string}` = tx.data as `0x${string}`;

  // ── Permit2 approval + signature ─────────────────────────────────────────
  if (quote.permit2?.type === "Permit2" && quote.permit2.eip712) {
    // 1. Ensure token is approved to the Permit2 contract
    const permit2Allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, PERMIT2_ADDRESS],
    });
    if (permit2Allowance < tokenBalance) {
      logger.info({ ...logCtx, spender: PERMIT2_ADDRESS }, "0x sell: approving Permit2 contract");
      const approveTx = await walletClient.writeContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [PERMIT2_ADDRESS, maxUint256],
        chain: base,
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
      logger.info({ ...logCtx, approveTx }, "0x sell: Permit2 approval confirmed");
    }

    // 2. Sign the EIP-712 Permit2 message
    const eip712 = quote.permit2.eip712;
    const signature = await walletClient.signTypedData({
      account,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      domain: eip712.domain as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      types: eip712.types as any,
      primaryType: eip712.primaryType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      message: eip712.message as any,
    });

    // 3. Append signature (without 0x prefix) to tx data — 0x v2 convention
    txData = (tx.data + signature.slice(2)) as `0x${string}`;
    logger.info({ ...logCtx, sigLength: signature.length }, "0x sell: Permit2 signature appended");

  } else {
    // AllowanceHolder path — traditional ERC-20 approve(spender, amount)
    const spenderAddress = (quote.issues?.allowance?.spender ?? tx.to) as Address;
    if (spenderAddress) {
      const allowance = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account.address, spenderAddress],
      });
      if (allowance < tokenBalance) {
        logger.info({ ...logCtx, spender: spenderAddress }, "0x sell: approving AllowanceHolder spender");
        const approveTx = await walletClient.writeContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [spenderAddress, maxUint256],
          chain: base,
          account,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
        logger.info({ ...logCtx, approveTx }, "0x sell: AllowanceHolder approval confirmed");
      }
    }
  }

  // ── Gas estimation ───────────────────────────────────────────────────────
  const fees = await publicClient.estimateFeesPerGas();
  const txValue = toBigIntSafe(tx.value);

  let estimatedGas: bigint;
  try {
    estimatedGas = await publicClient.estimateGas({
      to: tx.to as Address,
      data: txData,
      value: txValue,
      account: account.address,
    });
  } catch (gasErr) {
    const gasErrMsg = gasErr instanceof Error ? gasErr.message : String(gasErr);
    throw new Error(`0x sell gas estimation failed (tx likely to revert): ${gasErrMsg.slice(0, 300)}`);
  }

  const gasLimit = (estimatedGas * 120n) / 100n;
  const maxFeePerGas = fees.maxFeePerGas;
  const maxPriorityFeePerGas =
    fees.maxPriorityFeePerGas < maxFeePerGas ? fees.maxPriorityFeePerGas : maxFeePerGas;

  // ── Pre-flight balance check ─────────────────────────────────────────────
  const ethBalanceBefore = await publicClient.getBalance({ address: account.address });
  if (ethBalanceBefore < gasLimit * maxFeePerGas + txValue) {
    throw new Error(
      `0x sell aborted — insufficient ETH for gas: wallet ${formatEther(ethBalanceBefore)} ETH, ` +
      `estimated cost ${formatEther(gasLimit * maxFeePerGas)} ETH`,
    );
  }

  logger.info(
    { ...logCtx, estimatedGas: estimatedGas.toString(), gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString() },
    "0x sell: gas estimated",
  );

  // ── Submit transaction ───────────────────────────────────────────────────
  const txHash = await walletClient.sendTransaction({
    to: tx.to as Address,
    data: txData,
    value: txValue,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    account,
    chain: base,
  });

  logger.info({ ...logCtx, txHash }, "0x sell tx submitted");

  let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  } catch (receiptErr) {
    const baseMsg = receiptErr instanceof Error ? receiptErr.message : String(receiptErr);
    throw new Error(`0x sell receipt timeout for ${txHash}: ${baseMsg.slice(0, 200)}`);
  }

  if (receipt.status !== "success") {
    throw new Error(`0x sell tx reverted on-chain: ${txHash}`);
  }

  // ── Measure ETH received (balance diff + gas repayment) ──────────────────
  const gasCostActual = receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas);
  const ethBalanceAfter = await publicClient.getBalance({ address: account.address });
  const ethReceivedWei = ethBalanceAfter > ethBalanceBefore
    ? ethBalanceAfter - ethBalanceBefore + gasCostActual
    : (quote.minBuyAmount ? BigInt(quote.minBuyAmount) : 0n);
  const ethReceived = formatEther(ethReceivedWei);

  const [updated] = await db
    .update(tradesTable)
    .set({ status: "sold", sellTxHash: txHash, sellAmountEth: ethReceived, pnlEth: ethReceived })
    .where(eq(tradesTable.id, tradeId))
    .returning();

  broadcast("trade", updated);
  logger.info({ tradeId, ethReceived, reason }, "Sell confirmed via 0x API (token → ETH)");
}

/**
 * Sell via Li.Fi (token → ETH) — used as fallback when 0x API fails.
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

// ── executeBuy ─────────────────────────────────────────────────────────────

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

    // ── Step 3: EIP-1559 gas — fully automatic, pakai estimasi network ───────
    // maxGasGwei tidak lagi dipakai sebagai cap. Base fee selalu murah
    // sehingga cukup percayakan estimasi langsung ke node.
    const [feeEstimate, estimatedGas] = await Promise.all([
      publicClient.estimateFeesPerGas(),
      publicClient.estimateGas({
        to: toHex(call.target) as Address,
        data: toHex(call.data),
        value,
        account: account.address,
      }),
    ]);
    const maxFeePerGas = feeEstimate.maxFeePerGas;
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

    // ── Step 7: Fetch entry USDC value via price × balance ───────────────────
    // Fetch market price per token from Zora /coin API and multiply by the
    // actual token balance received. This avoids sell-quote price impact:
    // selling the full balance in a thin Zora pool crashes the simulated price,
    // making the entry value appear far lower than the real market value and
    // causing TP/SL thresholds to be miscalibrated.
    let entryValueUsdc: string | null = null;
    let receivedWei = 0n;
    try {
      const balAfterFinal = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      receivedWei = balAfterFinal > balBeforeBuy ? balAfterFinal - balBeforeBuy : 0n;
    } catch { /* non-fatal */ }

    if (receivedWei > 0n) {
      try {
        const usdcVal = await fetchPositionValueUsdc(tokenAddress, receivedWei);
        if (usdcVal !== null) {
          entryValueUsdc = usdcVal.toFixed(6);
          logger.info({ entryValueUsdc, tokenAddress }, "Entry USDC value measured via price × balance");
        }
      } catch (err) {
        logger.warn({ err }, "Failed to fetch entry USDC value — TP/SL will be skipped");
      }
    }

    const success = receipt.status === "success";
    const [updated] = await db
      .update(tradesTable)
      .set({
        txHash,
        status: success ? "confirmed" : "failed",
        gasUsedEth,
        tokenAmount: tokenAmount || null,
        blockNumber: Number(receipt.blockNumber),
        entryValueUsdc: success ? entryValueUsdc : null,
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
      if ((takeProfitPercent || stopLossPercent) && entryValueUsdc) {
        monitorTpSlSniper(
          tradeRow.id,
          tokenAddress,
          parseFloat(entryValueUsdc),
          takeProfitPercent ?? null,
          stopLossPercent ?? null,
          slippagePercent,
          maxGasGwei,
        ).catch((err) =>
          logger.error({ err, tradeId: tradeRow.id }, "Sniper TP/SL monitor error"),
        );
        logger.info(
          { tradeId: tradeRow.id, takeProfitPercent, stopLossPercent, entryValueUsdc },
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
  entryValueUsdc: number,
  takeProfitPercent: number | null,
  stopLossPercent: number | null,
  slippagePercent: number,
  maxGasGwei: number,
): Promise<void> {
  if (!takeProfitPercent && !stopLossPercent) return;

  logger.info(
    { tradeId, entryValueUsdc, takeProfitPercent, stopLossPercent },
    "Sniper TP/SL monitor started — tracking position value in USDC",
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

      // ── Read current token balance then compute value via price × balance ──
      // Uses market price from Zora /coin API multiplied by current balance.
      // Consistent with entry value measurement — both use price × balance so
      // PnL% reflects actual price movement, not sell-side price impact.
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
          .set({ status: "sold", failReason: "Balance zero during TP/SL monitor" })
          .where(eq(tradesTable.id, tradeId));
        return;
      }

      const currentValueUsdc = await fetchPositionValueUsdc(tokenAddress, tokenBalance);

      if (currentValueUsdc === null) {
        logger.debug(
          { tradeId, tokenAddress },
          "Sniper TP/SL: price not yet available — token may still be indexing, retrying",
        );
        continue;
      }

      const pnlPct = ((currentValueUsdc - entryValueUsdc) / entryValueUsdc) * 100;
      logger.debug(
        { tradeId, currentValueUsdc, entryValueUsdc, pnlPct: pnlPct.toFixed(2) },
        "Sniper TP/SL value check",
      );

      // Broadcast live price snapshot to frontend — keeps PositionCard in
      // sync with the monitor's own view without an extra Zora API call.
      const tokenAmount = parseFloat(formatUnits(tokenBalance, 18));
      const priceUsd = tokenAmount > 0 ? currentValueUsdc / tokenAmount : 0;
      broadcast("position_update", { tradeId, currentValueUsdc, pnlPct, priceUsd });

      // ── Check trigger ────────────────────────────────────────────────────
      let reason: "take_profit" | "stop_loss" | null = null;
      if (takeProfitPercent !== null && pnlPct >= takeProfitPercent) reason = "take_profit";
      else if (stopLossPercent !== null && pnlPct <= -stopLossPercent) reason = "stop_loss";

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
        { tradeId, reason, currentValueUsdc, entryValueUsdc, pnlPct: pnlPct.toFixed(2) },
        "Sniper TP/SL triggered — executing sell via Zora API",
      );

      // tokenBalance already read above for the value probe — reuse it here.

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


// Guard flag: prevents double execution when both index.ts and startSniper() call this
// function in the same server lifetime (e.g. bot started right after boot).
let sniperTpSlRecovered = false;
/**
 * On server restart, re-attach Zora-based TP/SL monitors for confirmed sniper
 * trades that still have TP or SL set. Mirrors recoverTpSlMonitors in
 * routes/manual.ts but targets source='sniper' and uses the Zora API monitor.
 */
export async function recoverSniperTpSlMonitors(): Promise<void> {
  if (sniperTpSlRecovered) {
    logger.info("Sniper TP/SL recovery: already done, skipping duplicate call");
    return;
  }
  sniperTpSlRecovered = true;
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

    // Only recover trades that have entryValueUsdc — older trades without it
    // cannot use the value-based monitor and will be left as-is.
    const recoverable = openTrades.filter(
      (t) => (t.takeProfitPercent || t.stopLossPercent) && t.entryValueUsdc,
    );

    if (recoverable.length === 0) {
      logger.info("Sniper TP/SL recovery: no active monitors to restart");
      return;
    }

    logger.info({ count: recoverable.length }, "Sniper TP/SL recovery: restarting monitors");

    // Read current config for slippage/gas (applied at sell time)
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
        logger.error({ err, tradeId: trade.id }, "Sniper TP/SL recovery monitor error"),
      );

      logger.info(
        { tradeId: trade.id, token: trade.tokenAddress, tp, sl, entryValueUsdc },
        "Sniper TP/SL monitor recovered",
      );
    }
  } catch (err) {
    logger.error({ err }, "Sniper TP/SL recovery failed — monitors not restarted");
  }
}
