import { Router, type IRouter } from "express";
import { db, tradesTable, creatorsTable } from "@workspace/db";
import { eq, count, desc } from "drizzle-orm";
import { botState } from "../bot/state";
import { GetDashboardResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard", async (_req, res): Promise<void> => {
  const state = botState.get();

  const [totalRow] = await db.select({ total: count() }).from(tradesTable);
  botState.update({ totalTrades: totalRow?.total ?? 0 });

  const recentTrades = await db
    .select()
    .from(tradesTable)
    .orderBy(desc(tradesTable.timestamp))
    .limit(10);

  const [confirmedRow] = await db
    .select({ total: count() })
    .from(tradesTable)
    .where(eq(tradesTable.status, "confirmed"));
  const [failedRow] = await db
    .select({ total: count() })
    .from(tradesTable)
    .where(eq(tradesTable.status, "failed"));
  const [soldRow] = await db
    .select({ total: count() })
    .from(tradesTable)
    .where(eq(tradesTable.status, "sold"));

  const totalTrades = totalRow?.total ?? 0;
  const winCount = soldRow?.total ?? 0;
  const failedTrades = failedRow?.total ?? 0;

  const stats = {
    totalTrades,
    successfulTrades: confirmedRow?.total ?? 0,
    failedTrades,
    totalEthSpent: "0",
    totalEthRecovered: "0",
    totalPnlEth: "0",
    winCount,
    lossCount: failedTrades,
    winRatePercent: totalTrades > 0 ? (winCount / totalTrades) * 100 : 0,
    avgBuyAmountEth: "0",
    todayTrades: 0,
    todayEthSpent: "0",
  };

  const topCreators = await db
    .select()
    .from(creatorsTable)
    .orderBy(desc(creatorsTable.totalSniped))
    .limit(5);

  const dashboard = {
    botStatus: {
      running: state.running,
      walletAddress: state.walletAddress ?? null,
      walletBalanceEth: state.walletBalanceEth ?? null,
      totalTrades: state.totalTrades,
      snipedToday: state.snipedToday,
      uptimeSeconds: botState.getUptimeSeconds(),
      lastEventAt: state.lastEventAt ?? null,
      network: state.network,
    },
    recentTrades,
    stats,
    topCreators,
  };

  res.json(GetDashboardResponse.parse(dashboard));
});

export default router;
