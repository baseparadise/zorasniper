import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  formatEther,
  formatUnits,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { db, tradesTable, creatorsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { botState } from "./state";
import { broadcast } from "./ws";

// ERC20 balanceOf ABI — used to measure tokens received after buy.
const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Zora Quote API endpoint
const ZORA_QUOTE_API = "https://api-sdk.zora.engineering";

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

/**
 * Fetch a buy quote from Zora Quote API.
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
          `Zora quote attempt ${attempt}/3 — pool not ready yet, retry in 5s`
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

    logger.info({ attempt, target: data.call.target }, "Zora quote OK");
    return data.call as ZoraCall;
  }

  throw new Error("Zora quote failed after 3 attempts — pool not ready or token invalid");
}

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
    const feeEstimate = await publicClient.estimateFeesPerGas();
    const maxFeePerGas =
      feeEstimate.maxFeePerGas < maxFeeCapWei ? feeEstimate.maxFeePerGas : maxFeeCapWei;
    const maxPriorityFeePerGas =
      feeEstimate.maxPriorityFeePerGas < maxFeePerGas
        ? feeEstimate.maxPriorityFeePerGas
        : maxFeePerGas;

    // ── Step 4: Send transaction ───────────────────────────────────────────────
    const txHash = await walletClient.sendTransaction({
      to: call.target as Address,
      data: call.data as `0x${string}`,
      value,
      chain: base,
      account,
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
      receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas)
    );

    // ── Step 6: Measure tokens received via balanceOf diff ────────────────────
    let tokenAmount = "";
    try {
      const [balBefore, balAfter] = await Promise.all([
        publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [account.address],
          blockNumber: receipt.blockNumber - 1n,
        }),
        publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_BALANCE_ABI,
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
