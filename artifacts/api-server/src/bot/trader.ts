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

function getWalletKey(): `0x${string}` {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) throw new Error("WALLET_PRIVATE_KEY is not set");
  return key.startsWith("0x") ? (key as `0x${string}`) : `0x${key}`;
}

export async function executeBuy(params: TradeParams): Promise<void> {
  const {
    tokenAddress,
    tokenName,
    tokenSymbol,
    creatorAddress,
    buyAmountEth,
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
    const publicClient = createPublicClient({ chain: base, transport: http(getRpcUrl()) });
    const walletClient = createWalletClient({ account, chain: base, transport: http(getRpcUrl()) });

    const value = parseEther(buyAmountEth);
    const minOrderSize = 0n; // accept any fill

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
        "0x0000000000000000000000000000000000000000" as Address,
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
    const isConfirmed = receipt.status === "success";

    const [updated] = await db
      .update(tradesTable)
      .set({
        txHash,
        status: isConfirmed ? "confirmed" : "failed",
        gasUsedEth,
        blockNumber: Number(receipt.blockNumber),
        failReason: isConfirmed ? null : "Transaction reverted on-chain",
      })
      .where(eq(tradesTable.id, tradeRow.id))
      .returning();

    // Increment creator snipe count and bot counters only on confirmed buys.
    if (isConfirmed) {
      await db
        .update(creatorsTable)
        .set({ totalSniped: sql`${creatorsTable.totalSniped} + 1` })
        .where(eq(creatorsTable.address, creatorAddress.toLowerCase()));

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
    const publicClient = createPublicClient({ chain: base, transport: http(getRpcUrl()) });
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
