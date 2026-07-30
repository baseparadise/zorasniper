import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { count, ne } from "drizzle-orm";
import { botState } from "../bot/state";
import { startSniper, stopSniper } from "../bot/sniper";
import { getWalletAddress } from "../bot/trader";
import { GetBotStatusResponse, StartBotResponse, StopBotResponse } from "@workspace/api-zod";

const router: IRouter = Router();

function buildStatusResponse() {
  const state = botState.get();
  if (!state.walletAddress) {
    const addr = getWalletAddress();
    if (addr) botState.update({ walletAddress: addr });
  }
  return {
    running: state.running,
    walletAddress: state.walletAddress ?? null,
    walletBalanceEth: state.walletBalanceEth ?? null,
    totalTrades: state.totalTrades,
    snipedToday: state.snipedToday,
    uptimeSeconds: botState.getUptimeSeconds(),
    lastEventAt: state.lastEventAt ?? null,
    network: state.network,
  };
}

router.get("/bot/status", async (_req, res): Promise<void> => {
  // Sync totalTrades from DB — exclude "skipped" (detected but not attempted)
  const [row] = await db
    .select({ total: count() })
    .from(tradesTable)
    .where(ne(tradesTable.status, "skipped"));
  botState.update({ totalTrades: row?.total ?? 0 });

  res.json(GetBotStatusResponse.parse(buildStatusResponse()));
});

router.post("/bot/start", async (req, res): Promise<void> => {
  if (botState.get().running) {
    res.json(StartBotResponse.parse(buildStatusResponse()));
    return;
  }
  try {
    await startSniper();
    res.json(StartBotResponse.parse(buildStatusResponse()));
  } catch (err) {
    req.log.error({ err }, "Failed to start bot");
    res.status(500).json({ error: "Failed to start bot. Check ALCHEMY_RPC_URL and WALLET_PRIVATE_KEY." });
  }
});

// Synchronous stop — no async needed; stopSniper() is synchronous.
router.post("/bot/stop", (_req, res): void => {
  stopSniper();
  res.json(StopBotResponse.parse(buildStatusResponse()));
});

export default router;
