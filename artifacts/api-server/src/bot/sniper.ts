import { createPublicClient, webSocket, type Address } from "viem";
import { base } from "viem/chains";
import { db, creatorsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { botState } from "./state";
import { broadcast } from "./ws";
import { executeBuy, getWalletBalance } from "./trader";
import { loadConfig } from "../lib/config";

// Zora Coins factory on Base mainnet
// Configure via env ZORA_FACTORY_ADDRESS to override
const ZORA_FACTORY_ADDRESS =
  (process.env.ZORA_FACTORY_ADDRESS as Address | undefined) ??
  "0x777777722D078c97c6ad07d9f36801e653E356B9";

const ZORA_COIN_FACTORY_ABI = [
  {
    type: "event",
    name: "CoinCreated",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "payoutRecipient", type: "address", indexed: true },
      { name: "platformReferrer", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: false },
      { name: "uri", type: "string", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "coin", type: "address", indexed: false },
      { name: "pool", type: "address", indexed: false },
      { name: "marketType", type: "uint8", indexed: false },
    ],
  },
] as const;

let unwatch: (() => void) | null = null;
let balanceInterval: ReturnType<typeof setInterval> | null = null;

function getWsRpcUrl(): string {
  const url = process.env.ALCHEMY_RPC_URL ?? "";
  // Convert HTTPS to WSS for WebSocket transport
  return url.replace("https://", "wss://").replace("http://", "ws://");
}

export async function startSniper(): Promise<void> {
  if (botState.get().running) {
    logger.warn("Sniper already running");
    return;
  }

  logger.info({ factory: ZORA_FACTORY_ADDRESS }, "Starting Zora sniper");

  // Update wallet info
  const wallet = await getWalletBalance();
  botState.update({
    running: true,
    startedAt: new Date(),
    walletAddress: wallet?.address ?? null,
    walletBalanceEth: wallet?.balanceEth ?? null,
    network: "base",
  });

  broadcast("status", botState.get());

  const wsUrl = getWsRpcUrl();

  try {
    const client = createPublicClient({
      chain: base,
      transport: webSocket(wsUrl),
    });

    unwatch = client.watchContractEvent({
      address: ZORA_FACTORY_ADDRESS,
      abi: ZORA_COIN_FACTORY_ABI,
      eventName: "CoinCreated",
      onLogs: async (logs) => {
        for (const log of logs) {
          const { caller, payoutRecipient, name, symbol, coin } = log.args;
          if (!coin || !name || !symbol || !caller) continue;

          const creatorAddr = (payoutRecipient ?? caller).toLowerCase();

          logger.info({ coin, name, symbol, creator: creatorAddr }, "New Zora coin detected");
          botState.update({ lastEventAt: new Date().toISOString() });
          broadcast("event", { type: "coin_created", coin, name, symbol, creator: creatorAddr });

          const config = await loadConfig();
          if (!config.enabled) continue;

          let shouldSnipe = false;

          if (config.watchMode === "all") {
            shouldSnipe = true;
          } else {
            // Whitelist mode
            const [creator] = await db
              .select()
              .from(creatorsTable)
              .where(eq(creatorsTable.address, creatorAddr))
              .limit(1);
            shouldSnipe = !!creator?.enabled;
          }

          if (!shouldSnipe) {
            logger.debug({ creatorAddr }, "Creator not in whitelist, skipping");
            continue;
          }

          logger.info({ coin, name, creator: creatorAddr }, "Sniping coin");

          // Fire-and-forget: don't await so we keep listening
          executeBuy({
            tokenAddress: coin as Address,
            tokenName: name,
            tokenSymbol: symbol,
            creatorAddress: creatorAddr,
            buyAmountEth: config.buyAmountEth,
            slippagePercent: config.slippagePercent,
            maxGasGwei: config.maxGasGwei,
          }).catch((err) => logger.error({ err }, "executeBuy error"));
        }
      },
      onError: (err) => {
        logger.error({ err }, "WatchContractEvent error");
        broadcast("error", { message: "Event listener error" });
      },
    });

    logger.info("Sniper listening for CoinCreated events");
  } catch (err) {
    logger.error({ err }, "Failed to start sniper");
    botState.update({ running: false, startedAt: null });
    throw err;
  }

  // Refresh wallet balance every 30s
  balanceInterval = setInterval(async () => {
    const wallet = await getWalletBalance();
    if (wallet) {
      botState.update({ walletBalanceEth: wallet.balanceEth });
      broadcast("status", botState.get());
    }
  }, 30_000);
}

export function stopSniper(): void {
  if (unwatch) {
    unwatch();
    unwatch = null;
  }
  if (balanceInterval) {
    clearInterval(balanceInterval);
    balanceInterval = null;
  }
  botState.update({ running: false, startedAt: null });
  broadcast("status", botState.get());
  logger.info("Sniper stopped");
}
