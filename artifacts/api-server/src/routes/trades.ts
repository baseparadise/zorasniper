import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { eq, count, sum, desc } from "drizzle-orm";
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
  const all = await db.select({ total: count() }).from(tradesTable);
  const confirmed = await db
    .select({ total: count() })
    .from(tradesTable)
    .where(eq(tradesTable.status, "confirmed"));
  const failed = await db
    .select({ total: count() })
    .from(tradesTable)
    .where(eq(tradesTable.status, "failed"));
  const sold = await db
    .select({ total: count() })
    .from(tradesTable)
    .where(eq(tradesTable.status, "sold"));

  const totalTrades = all[0]?.total ?? 0;
  const successfulTrades = confirmed[0]?.total ?? 0;
  const failedTrades = failed[0]?.total ?? 0;
  const soldTrades = sold[0]?.total ?? 0;
  const winCount = soldTrades; // simplified: sold = win
  const lossCount = failedTrades;

  // Today's stats
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayRows = await db
    .select({ total: count() })
    .from(tradesTable);
  const todayTrades = todayRows[0]?.total ?? 0;

  const stats = {
    totalTrades,
    successfulTrades,
    failedTrades,
    totalEthSpent: "0",
    totalEthRecovered: "0",
    totalPnlEth: "0",
    winCount,
    lossCount,
    winRatePercent: totalTrades > 0 ? (winCount / totalTrades) * 100 : 0,
    avgBuyAmountEth: "0",
    todayTrades,
    todayEthSpent: "0",
  };

  res.json(GetTradeStatsResponse.parse(stats));
});

export default router;
