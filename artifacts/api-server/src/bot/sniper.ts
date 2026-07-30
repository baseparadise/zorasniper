import { createPublicClient, webSocket, type Address } from "viem";
import { base } from "viem/chains";
import { db, creatorsTable, tradesTable } from "@workspace/db";
import { eq, and, gte, ne, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { botState } from "./state";
import { broadcast } from "./ws";
import { executeBuy, getWalletBalance, recoverSniperTpSlMonitors } from "./trader";
import { loadConfig } from "../lib/config";

// Zora Coins factory on Base mainnet — emits CoinCreated, CoinCreatedV4,
// CreatorCoinCreated, and TrendCoinCreated.
// Configure via env ZORA_FACTORY_ADDRESS to override.
const ZORA_FACTORY_ADDRESS =
  (process.env.ZORA_FACTORY_ADDRESS as Address | undefined) ??
  "0x777777751622c0d3258f214F9DF38E35BF45baF3";

// Full ABI covering all four coin-creation events emitted by the factory.
// • CoinCreated        — V3 coins  (old, still emitted)
// • CoinCreatedV4      — V4 coins  (replaces pool address with poolKey tuple)
// • CreatorCoinCreated — Creator-linked coins (same shape as CoinCreatedV4)
// • TrendCoinCreated   — Trend coins (only caller indexed; no payoutRecipient/name)
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
  {
    type: "event",
    name: "CoinCreatedV4",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "payoutRecipient", type: "address", indexed: true },
      { name: "platformReferrer", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: false },
      { name: "uri", type: "string", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "coin", type: "address", indexed: false },
      {
        name: "poolKey",
        type: "tuple",
        indexed: false,
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "poolKeyHash", type: "bytes32", indexed: false },
      { name: "version", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CreatorCoinCreated",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "payoutRecipient", type: "address", indexed: true },
      { name: "platformReferrer", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: false },
      { name: "uri", type: "string", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "coin", type: "address", indexed: false },
      {
        name: "poolKey",
        type: "tuple",
        indexed: false,
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "poolKeyHash", type: "bytes32", indexed: false },
      { name: "version", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TrendCoinCreated",
    // NOTE: TrendCoinCreated has NO payoutRecipient/platformReferrer indexed fields
    // and NO name field — only caller, symbol, coin, poolKey, poolKeyHash, poolConfig, version.
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "symbol", type: "string", indexed: false },
      { name: "coin", type: "address", indexed: false },
      {
        name: "poolKey",
        type: "tuple",
        indexed: false,
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "poolKeyHash", type: "bytes32", indexed: false },
      { name: "poolConfig", type: "bytes", indexed: false },
      { name: "version", type: "string", indexed: false },
    ],
  },
] as const;

const COIN_EVENT_NAMES = [
  "CoinCreated",
  "CoinCreatedV4",
  "CreatorCoinCreated",
  "TrendCoinCreated",
] as const;

type CoinEventName = (typeof COIN_EVENT_NAMES)[number];

let unwatch: (() => void) | null = null;
let balanceInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

function getWsRpcUrl(): string {
  const url = process.env.ALCHEMY_RPC_URL ?? "";
  return url.replace("https://", "wss://").replace("http://", "ws://");
}

/** Parse a stored text column into a number, returning null if empty/invalid */
function parseStoredNumber(val: string | null | undefined): number | null {
  if (!val || val === "") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/** Count non-failed, non-skipped trades for a creator today (UTC midnight → now).
 *  Failed/skipped trades are excluded so they don't burn the daily quota. */
async function countTodayBuys(creatorAddr: string): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.creatorAddress, creatorAddr),
        gte(tradesTable.timestamp, todayStart),
        ne(tradesTable.status, "failed"),
        ne(tradesTable.status, "skipped")
      )
    );

  return count ?? 0;
}

/** Insert a "skipped" record so users can verify deploy detection even when not buying. */
async function recordSkipped(
  coin: Address,
  name: string,
  symbol: string,
  creatorAddr: string,
  reason: string
): Promise<void> {
  try {
    const [row] = await db
      .insert(tradesTable)
      .values({
        tokenAddress: coin,
        tokenName: name,
        tokenSymbol: symbol,
        creatorAddress: creatorAddr,
        buyAmountEth: "0",
        status: "skipped",
        failReason: reason,
      })
      .returning();
    broadcast("trade", row);
  } catch (err) {
    logger.error({ err }, "Failed to record skipped trade");
  }
}

/** Core handler invoked for every coin-creation event from any event type. */
async function handleCoinCreated(params: {
  eventName: CoinEventName;
  caller: Address;
  payoutRecipient?: Address;
  coin: Address;
  name: string;
  symbol: string;
}): Promise<void> {
  const { eventName, caller, payoutRecipient, coin, name, symbol } = params;

  const creatorAddr = (payoutRecipient ?? caller).toLowerCase();

  // Turunkan ke debug — event ini terjadi untuk SETIAP coin di factory Zora
  // (bisa ratusan per jam). Info-level hanya setelah whitelist match di bawah.
  logger.debug(
    { coin, symbol, creator: creatorAddr, eventName },
    "Factory event received"
  );

  const config = await loadConfig();

  let shouldSnipe = false;
  let creatorRow: typeof creatorsTable.$inferSelect | null = null;

  if (config.watchMode === "all") {
    shouldSnipe = true;
  } else {
    // Case-insensitive lookup — checksum addresses di DB tetap match.
    const [found] = await db
      .select()
      .from(creatorsTable)
      .where(sql`lower(${creatorsTable.address}) = ${creatorAddr}`)
      .limit(1);
    creatorRow = found ?? null;
    shouldSnipe = !!creatorRow?.enabled;
  }

  if (!shouldSnipe) {
    // Bukan target wallet — tidak perlu log apapun, langsung return.
    return;
  }

  // ── Dari sini ke bawah: creator ada di whitelist ──────────────────────────
  logger.info(
    { coin, name, symbol, creator: creatorAddr, eventName },
    "Target wallet detected new coin"
  );
  botState.update({ lastEventAt: new Date().toISOString() });
  broadcast("event", { type: "coin_created", coin, name, symbol, creator: creatorAddr, eventName });

  // Bot is globally disabled — creator IS whitelisted but buy is paused.
  // Record this so the user can see detections even when the bot is off.
  if (!config.enabled) {
    logger.info({ creatorAddr }, "Bot is disabled, skipping buy");
    await recordSkipped(coin, name, symbol, creatorAddr, "Bot is disabled");
    return;
  }

  // Resolve effective settings: per-wallet overrides → global fallback
  const effectiveBuyAmount = creatorRow?.buyAmountEth ?? config.buyAmountEth;
  const effectiveSlippage =
    parseStoredNumber(creatorRow?.slippagePercent) ?? config.slippagePercent;
  const effectiveMaxGas =
    parseStoredNumber(creatorRow?.maxGasGwei) ?? config.maxGasGwei;
  const effectiveMaxBuysPerDay =
    creatorRow?.maxBuysPerDay ?? config.maxBuysPerDay;

  // ── Minimum liquidity check (config.minLiquidityEth) ─────────────────────
  // This is a deployment-time filter — the coin was just created so on-chain
  // liquidity is whatever the creator seeded.  We skip this check at creation
  // time because the pool hasn't been initialised yet; minLiquidityEth is
  // reserved for post-deployment sell guards and is noted here for clarity.
  // ─────────────────────────────────────────────────────────────────────────

  // ── Daily buy limit check ─────────────────────────────────────────────────
  if (effectiveMaxBuysPerDay != null && effectiveMaxBuysPerDay > 0) {
    const todayCount = await countTodayBuys(creatorAddr);
    if (todayCount >= effectiveMaxBuysPerDay) {
      const reason = `Daily buy limit reached (${todayCount}/${effectiveMaxBuysPerDay} today)`;
      logger.info(
        { creatorAddr, todayCount, limit: effectiveMaxBuysPerDay },
        "Daily buy limit reached for this wallet — skipping"
      );
      await recordSkipped(coin, name, symbol, creatorAddr, reason);
      broadcast("event", {
        type: "limit_reached",
        creator: creatorAddr,
        todayCount,
        limit: effectiveMaxBuysPerDay,
      });
      return;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  logger.info(
    { creatorAddr, coin, effectiveBuyAmount, eventName },
    "Creator matched — executing snipe"
  );

  // Fix: dedup guard — prevent double-buy if the same coin event is replayed
  // after a WebSocket reconnect. Check for any existing pending/confirmed trade
  // for this exact token address before firing the buy.
  const [dupTrade] = await db
    .select({ id: tradesTable.id })
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.tokenAddress, coin.toLowerCase()),
        inArray(tradesTable.status, ["pending", "confirmed"])
      )
    )
    .limit(1);

  if (dupTrade) {
    logger.warn(
      { coin, dupId: dupTrade.id },
      "Coin already pending/confirmed — skipping duplicate snipe"
    );
    await recordSkipped(
      coin,
      name,
      symbol,
      creatorAddr,
      `Duplicate: trade #${dupTrade.id} already pending/confirmed`
    );
    return;
  }

  // Fire-and-forget: don't await so we keep listening.
  // Pass eventName so executeBuy can derive the correct expectedMarketType.
  executeBuy({
    tokenAddress: coin,
    tokenName: name,
    tokenSymbol: symbol,
    creatorAddress: creatorAddr,
    buyAmountEth: effectiveBuyAmount,
    slippagePercent: effectiveSlippage,
    maxGasGwei: effectiveMaxGas,
    eventName,
    // Fix: TP/SL used to apply regardless of the "Auto-Sell Enabled" toggle —
    // the flag was saved but never read here, so turning it off in Settings
    // did nothing if TP/SL values were still stored from an earlier session.
    takeProfitPercent: config.autoSell ? config.takeProfitPercent : null,
    stopLossPercent: config.autoSell ? config.stopLossPercent : null,
  }).catch((err) => logger.error({ err }, "executeBuy error"));
}

/** Attach the WebSocket event listener for all coin-creation events. */
function attachListener(): void {
  if (unwatch) {
    unwatch();
    unwatch = null;
  }

  const wsUrl = getWsRpcUrl();

  const client = createPublicClient({
    chain: base,
    transport: webSocket(wsUrl),
  });

  // Watch ALL events emitted by the factory — no eventName filter so we catch
  // CoinCreated, CoinCreatedV4, CreatorCoinCreated, and TrendCoinCreated.
  unwatch = client.watchContractEvent({
    address: ZORA_FACTORY_ADDRESS,
    abi: ZORA_COIN_FACTORY_ABI,
    onLogs: async (logs) => {
      // Reset reconnect counter on successful events
      reconnectAttempts = 0;

      for (const log of logs) {
        const eventName = log.eventName as CoinEventName;
        if (!(COIN_EVENT_NAMES as readonly string[]).includes(eventName)) continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const args = log.args as any;

        const caller: Address | undefined = args.caller;
        const coin: Address | undefined = args.coin;
        const symbol: string | undefined = args.symbol;

        if (!coin || !symbol || !caller) continue;

        // TrendCoinCreated has no `name` field — synthesise one from symbol
        const name: string = args.name ?? `[Trend] ${symbol}`;

        // TrendCoinCreated has no `payoutRecipient` — fall back to caller
        const payoutRecipient: Address | undefined = args.payoutRecipient;

        await handleCoinCreated({
          eventName,
          caller,
          payoutRecipient,
          coin,
          name,
          symbol,
        });
      }
    },
    onError: (err) => {
      logger.error({ err }, "WatchContractEvent error — will reconnect");
      broadcast("error", { message: "Event listener error, reconnecting…" });
      scheduleReconnect();
    },
  });

  logger.info(
    { factory: ZORA_FACTORY_ADDRESS, events: COIN_EVENT_NAMES },
    "Sniper listening for all coin-creation events"
  );
}

/** Schedule a reconnect with exponential back-off (max 60 s). */
function scheduleReconnect(): void {
  if (reconnectTimeout) return; // already pending

  if (!botState.get().running) return; // bot was stopped manually

  const delay = Math.min(5_000 * Math.pow(2, reconnectAttempts), 60_000);
  reconnectAttempts++;

  logger.info({ delay, attempt: reconnectAttempts }, "Scheduling sniper reconnect");

  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    if (!botState.get().running) return;

    try {
      attachListener();
    } catch (err) {
      logger.error({ err }, "Reconnect failed");
      scheduleReconnect();
    }
  }, delay);
}

export async function startSniper(): Promise<void> {
  if (botState.get().running) {
    logger.warn("Sniper already running");
    return;
  }

  logger.info({ factory: ZORA_FACTORY_ADDRESS }, "Starting Zora sniper");

  const wallet = await getWalletBalance();
  botState.update({
    running: true,
    startedAt: new Date(),
    walletAddress: wallet?.address ?? null,
    walletBalanceEth: wallet?.balanceEth ?? null,
    network: "base",
  });

  broadcast("status", botState.get());

  reconnectAttempts = 0;
  attachListener();

  // Restart TP/SL monitors for sniper trades that survived a server restart
  recoverSniperTpSlMonitors().catch((err) =>
    logger.error({ err }, "Sniper TP/SL recovery failed")
  );

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
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
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
