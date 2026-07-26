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
    slippagePercent: _slippagePercent,
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
    const minOrderSize = 0n; // accept any amount; slippage protection via maxFeePerGas

    // Convert gwei → wei correctly: multiply by 1e9
    const maxFeePerGas = BigInt(Math.round(maxGasGwei * 1e9));
    const gasPrice = await publicClient.getGasPrice();
    const effectiveGasPrice = gasPrice > maxFeePerGas ? maxFeePerGas : gasPrice;

    const txHash = await walletClient.writeContract({
      address: tokenAddress as Address,
      abi: ZORA_COIN_ABI,
      functionName: "buy",
      args: [
        account.address,
        account.address,
        "0x0000000000000000000000000000000000000000" as Address, // no referrer
        "zora-sniper",
        0, // marketType
        minOrderSize,
        0n, // no price limit
      ],
      value,
      maxFeePerGas: effectiveGasPrice,
    });

    logger.info({ txHash, tokenAddress }, "Buy tx submitted");

    // Wait for receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });

    const gasUsedEth = formatEther(receipt.gasUsed * (receipt.effectiveGasPrice ?? effectiveGasPrice));
    const isConfirmed = receipt.status === "success";

    const [updated] = await db
      .update(tradesTable)
      .set({
        txHash,
        status: isConfirmed ? "confirmed" : "failed",
        gasUsedEth,
        blockNumber: Number(receipt.blockNumber),
        // If receipt came back failed, record that the tx reverted
        ...(isConfirmed ? {} : { failReason: "Transaction reverted on-chain" }),
      })
      .where(eq(tradesTable.id, tradeRow.id))
      .returning();

    // Only increment creator snipe count for confirmed (successful) buys
    if (isConfirmed) {
      await db
        .update(creatorsTable)
        .set({ totalSniped: sql`${creatorsTable.totalSniped} + 1` })
        .where(eq(creatorsTable.address, creatorAddress.toLowerCase()));
    }

    const state = botState.get();
    botState.update({
      totalTrades: state.totalTrades + 1,
      snipedToday: state.snipedToday + 1,
      lastEventAt: new Date().toISOString(),
    });

    broadcast("trade", updated);
    logger.info({ txHash, status: updated.status, tokenName }, "Buy settled");
  } catch (err) {
    logger.error({ err, tokenAddress }, "Buy failed");
    const failReason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const [updated] = await db
      .update(tradesTable)
      .set({ status: "failed", failReason })
      .where(eq(tradesTable.id, tradeRow.id))
      .returning();
    // Count failed attempts toward today's snipe count
    botState.update({
      snipedToday: botState.get().snipedToday + 1,
      lastEventAt: new Date().toISOString(),
    });
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

// Synchronously derive wallet address from private key — no RPC call needed.
// Safe to call at any time; returns null if WALLET_PRIVATE_KEY is missing or malformed.
export function getWalletAddress(): string | null {
  try {
    const account = privateKeyToAccount(getWalletKey());
    return account.address;
  } catch {
    return null;
  }
}
