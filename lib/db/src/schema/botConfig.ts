import { pgTable, text } from "drizzle-orm/pg-core";

// Simple key-value store for bot configuration
export const botConfigTable = pgTable("bot_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type BotConfigRow = typeof botConfigTable.$inferSelect;

export const DEFAULT_CONFIG = {
  buyAmountEth: "0.01",
  slippagePercent: "5",
  maxGasGwei: "50",
  watchMode: "whitelist",
  enabled: "true",
  minLiquidityEth: "",
  autoSell: "false",
  takeProfitPercent: "",
  stopLossPercent: "",
  maxBuysPerDay: "", // empty = no limit
} as const;
