import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { eq, count, desc, gte, and, sql } from "drizzle-orm";
import {
  ListTradesQueryParams,
  ListTradesResponse,
  GetTradeStatsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/trades", async (req, res): Promise<void> => {
  const queryParsed = ListTradesQueryParams.safeParse(req.query);
  if (!queryParsed.success) {
    res.status(400).json({ error: queryParsed.error.message });
    return;
  }

  const { limit = 50, offset = 0, status } = queryParsed.data;

  const trades = status
    ? await db
        .select()
        .from(tradesTable)
        .where(eq(tradesTable.status, status))
        .orderBy(desc(tradesTable.timestamp))
        .limit(limit)
        .offset(offset)
    : await db
        .select()
        .from(tradesTable)
        .orderBy(desc(tradesTable.timestamp))
        .limit(limit)
        .offset(offset);
  res.json(ListTradesResponse.parse(trades));
});

router.get("/trades/stats", async (_req, res): Promise<void> => {
  const [allRow] = await db.select({ total: count() }).from(tradesTable);
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

  const totalTrades = allRow?.total ?? 0;
  const successfulTrades = confirmedRow?.total ?? 0;
  const failedTrades = failedRow?.total ?? 0;
  const soldTrades = soldRow?.total ?? 0;
  const winCount = soldTrades;
  const lossCount = failedTrades;

  // Today's stats — use a proper date filter
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [todayRow] = await db
    .select({ total: count() })
    .from(tradesTable)
    .where(gte(tradesTable.timestamp, today));
  const todayTrades = todayRow?.total ?? 0;

  // Real ETH stats via SQL aggregation on text→numeric cast
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
    successfulTrades,
    failedTrades,
    totalEthSpent: ethSpentRow?.total ?? "0",
    totalEthRecovered: ethRecoveredRow?.total ?? "0",
    totalPnlEth: pnlRow?.total ?? "0",
    winCount,
    lossCount,
    winRatePercent: totalTrades > 0 ? (winCount / totalTrades) * 100 : 0,
    avgBuyAmountEth: avgRow?.avg ?? "0",
    todayTrades,
    todayEthSpent: todayEthRow?.total ?? "0",
  };

  res.json(GetTradeStatsResponse.parse(stats));
});

export default router;
