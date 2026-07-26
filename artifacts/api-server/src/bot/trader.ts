import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  formatEther,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { db, tradesTable, creatorsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { botState } from "./state";
import { broadcast } from "./ws";

// Minimal ABI to call buy() on a deployed Zora coin contract.
const ZORA_COIN_ABI = [
  {
    type: "function",
    name: "buy",
    stateMutability: "payable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "refundRecipient", type: "address" },
      { name: "orderReferrer", type: "address" },
      { name: "comment", type: "string" },
      { name: "expectedMarketType", type: "uint8" },
      { name: "minOrderSize", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface TradeParams {
  tokenAddress: Address;
  tokenName: string;
  tokenSymbol: string;
  creatorAddress: string;
  buyAmountEth: string;
  slippagePercent: number;
  maxGasGwei: number;
}

function getRpcUrl(): string {
  const url = process.env.ALCHEMY_RPC_URL;
  if (!url) throw new Error("ALCHEMY_RPC_URL is not set");
  return url;
}

/**
 * Bug #3 fix: ALCHEMY_RPC_URL is typically a wss:// URL (needed by sniper.ts
 * for WebSocket event watching). The HTTP clients in trader.ts must use an
 * https:// endpoint — convert the scheme instead of reusing the raw URL.
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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export async function executeBuy(params: TradeParams): Promise<void> {
  const {
    tokenAddress,
    tokenName,
    tokenSymbol,
    creatorAddress,
    buyAmountEth,
    slippagePercent,
    maxGasGwei,
  } = params;

  logger.info({ tokenAddress, tokenName, buyAmountEth }, "Executing buy");

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
    // Bug #3 fix: use HTTP URL for JSON-RPC clients (not the wss:// WebSocket URL)
    const publicClient = createPublicClient({ chain: base, transport: http(getHttpRpcUrl()) });
    const walletClient = createWalletClient({ account, chain: base, transport: http(getHttpRpcUrl()) });

    const value = parseEther(buyAmountEth);

    // Bug #2 fix: simulate the buy to get the expected token output, then apply
    // slippagePercent as a minimum order size so the tx reverts on-chain if the
    // price has moved too far by the time our tx lands.
    let minOrderSize = 0n;
    try {
      const { result: expectedTokens } = await publicClient.simulateContract({
        address: tokenAddress,
        abi: ZORA_COIN_ABI,
        functionName: "buy",
        args: [account.address, account.address, ZERO_ADDRESS, "zora-sniper", 0, 0n, 0n],
        value,
        account,
      });
      // Convert slippagePercent (e.g. 5.0) to basis points (500), then compute floor.
      const slippageBps = BigInt(Math.round(slippagePercent * 100));
      minOrderSize = (expectedTokens * (10_000n - slippageBps)) / 10_000n;
      logger.info(
        { expectedTokens: expectedTokens.toString(), minOrderSize: minOrderSize.toString(), slippagePercent },
        "Slippage applied to buy"
      );
    } catch (simErr) {
      logger.warn(
        { simErr, tokenAddress },
        "Buy simulation failed — proceeding with minOrderSize=0 (no slippage protection)"
      );
      minOrderSize = 0n;
    }

    // EIP-1559 gas: cap maxFeePerGas at the user-configured limit.
    // Use estimateFeesPerGas() so we also get maxPriorityFeePerGas correctly.
    const maxFeeCapWei = BigInt(Math.round(maxGasGwei * 1e9));
    const feeEstimate = await publicClient.estimateFeesPerGas();
    const maxFeePerGas =
      feeEstimate.maxFeePerGas < maxFeeCapWei
        ? feeEstimate.maxFeePerGas
        : maxFeeCapWei;
    // Priority fee: use the network estimate but don't exceed the overall cap.
    const maxPriorityFeePerGas =
      feeEstimate.maxPriorityFeePerGas < maxFeePerGas
        ? feeEstimate.maxPriorityFeePerGas
        : maxFeePerGas;

    const txHash = await walletClient.writeContract({
      address: tokenAddress,
      abi: ZORA_COIN_ABI,
      functionName: "buy",
      args: [
        account.address,
        account.address,
        ZERO_ADDRESS,
        "zora-sniper",
        0,
        minOrderSize,
        0n,
      ],
      value,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    logger.info({ txHash, tokenAddress }, "Buy tx submitted");

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    });

    const gasUsedEth = formatEther(
      receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas)
    );

    // Parse token amount received from the transaction logs / return value.
    // We read it from the receipt logs if possible; fall back to empty string.
    let tokenAmount = "";
    try {
      // The buy() return value is emitted as the first topic-free log data on success.
      // Attempt a simple re-simulation on the mined block to get the return value.
      const { result } = await publicClient.simulateContract({
        address: tokenAddress,
        abi: ZORA_COIN_ABI,
        functionName: "buy",
        args: [account.address, account.address, ZERO_ADDRESS, "zora-sniper", 0, minOrderSize, 0n],
        value,
        account,
        blockNumber: receipt.blockNumber,
      });
      tokenAmount = result.toString();
    } catch {
      // Non-fatal — token amount will be left blank
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
      })
      .where(eq(tradesTable.id, tradeRow.id))
      .returning();

    // Update per-creator snipe counter on success
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
      // Failed on-chain — update lastEventAt but don't increment snipedToday.
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

    // Exception (pre-submission failure) — don't increment snipedToday.
    botState.update({ lastEventAt: new Date().toISOString() });
    broadcast("trade", updated);
  }
}

export async function getWalletBalance(): Promise<{ address: string; balanceEth: string } | null> {
  try {
    const account = privateKeyToAccount(getWalletKey());
    // Bug #3 fix: use HTTP URL here too
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
