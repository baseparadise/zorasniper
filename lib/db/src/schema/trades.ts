import { pgTable, text, serial, timestamp, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  txHash: text("tx_hash"),
  tokenAddress: text("token_address").notNull(),
  tokenName: text("token_name").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  creatorAddress: text("creator_address").notNull(),
  buyAmountEth: text("buy_amount_eth").notNull(),
  tokenAmount: text("token_amount"),
  gasUsedEth: text("gas_used_eth"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull().default("pending"), // pending | confirmed | failed | sold | skipped | selling
  failReason: text("fail_reason"),
  sellTxHash: text("sell_tx_hash"),
  sellAmountEth: text("sell_amount_eth"),
  pnlEth: text("pnl_eth"),
  blockNumber: bigint("block_number", { mode: "number" }),
  // Manual buy fields
  source: text("source").notNull().default("sniper"), // 'sniper' | 'manual'
  takeProfitPercent: text("take_profit_percent"),
  stopLossPercent: text("stop_loss_percent"),
  // USDC value of token position at time of buy (from sell-direction quote post-buy).
  // Used as the TP/SL cost basis: more accurate than ETH_spent / tokens_received
  // because it reflects actual market value after price impact and fees.
  entryValueUsdc: text("entry_value_usdc"),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({
  id: true,
  timestamp: true,
});
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;

