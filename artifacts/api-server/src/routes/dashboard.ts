import { Router, type IRouter } from "express";
import { db, tradesTable, creatorsTable } from "@workspace/db";
import { eq, count, desc, gte, and, ne, sql } from "drizzle-orm";
import { botState } from "../bot/state";
import { GetDashboardResponse } from "@workspace/api-zod";
import { getWalletAddress } from "../bot/trader";

const router: IRouter = Router();

router.get("/dashboard", async (_req, res): Promise<void> => {
  if (!botState.get().walletAddress) {
    const addr = getWalletAddress();
    if (addr) botState.update({ walletAddress: addr });
  }
  const state = botState.get();

  // totalTrades excludes "skipped" — skipped = deploy detected but buy not attempted
  const [totalRow] = await db
    .select({ total: count() })
    .from(tradesTable)
    .where(ne(tradesTable.status, "skipped"));
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

  // Bug #4 fix: lossCount = trades that were sold at a financial loss (pnl_eth < 0),
  // NOT failed trades. A failed trade is a technical failure; a loss is a bad trade
  // that completed but returned less ETH than spent.
  const [lossRow] = await db
    .select({ total: count() })
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.status, "sold"),
        sql`NULLIF(pnl_eth, '')::numeric < 0`
      )
    );

  const totalTrades = totalRow?.total ?? 0;
  const winCount = soldRow?.total ?? 0;
  const failedTrades = failedRow?.total ?? 0;
  const lossCount = lossRow?.total ?? 0;

  // Today — proper date filter, exclude skipped
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [todayRow] = await db
    .select({ total: count() })
    .from(tradesTable)
    .where(and(gte(tradesTable.timestamp, today), ne(tradesTable.status, "skipped")));

  // Real ETH stats
  const [ethSpentRow] = await db
    .select({
      total: sql<string>`COALESCE(SUM(NULLIF(buy_amount_eth, '')::numeric), 0)::text`,
    })
    .from(tradesTable)
    .where(eq(tradesTable.status, "confirmed"));

  const [todayEthRow] = await db
    .select({
      total: sql<string>`COALESCE(SUM(NULLIF(buy_amount_eth, '')::numeric), 0)::text`,
    })
    .from(tradesTable)
    .where(and(gte(tradesTable.timestamp, today), eq(tradesTable.status, "confirmed")));

  const [ethRecoveredRow] = await db
    .select({
      total: sql<string>`COALESCE(SUM(NULLIF(sell_amount_eth, '')::numeric), 0)::text`,
    })
    .from(tradesTable)
    .where(eq(tradesTable.status, "sold"));

  const [pnlRow] = await db
    .select({
      total: sql<string>`COALESCE(SUM(NULLIF(pnl_eth, '')::numeric), 0)::text`,
    })
    .from(tradesTable);

  const [avgRow] = await db
    .select({
      avg: sql<string>`COALESCE(AVG(NULLIF(buy_amount_eth, '')::numeric), 0)::text`,
    })
    .from(tradesTable)
    .where(eq(tradesTable.status, "confirmed"));

  const stats = {
    totalTrades,
    successfulTrades: confirmedRow?.total ?? 0,
    failedTrades,
    totalEthSpent: ethSpentRow?.total ?? "0",
    totalEthRecovered: ethRecoveredRow?.total ?? "0",
    totalPnlEth: pnlRow?.total ?? "0",
    winCount,
    lossCount,
    winRatePercent: totalTrades > 0 ? (winCount / totalTrades) * 100 : 0,
    avgBuyAmountEth: avgRow?.avg ?? "0",
    todayTrades: todayRow?.total ?? 0,
    todayEthSpent: todayEthRow?.total ?? "0",
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
