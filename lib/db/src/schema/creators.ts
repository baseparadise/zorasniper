import { pgTable, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const creatorsTable = pgTable("creators", {
  address: text("address").primaryKey(),
  label: text("label").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  totalSniped: integer("total_sniped").notNull().default(0),
  zoraProfileUrl: text("zora_profile_url"),
  // Per-wallet sniper settings — null means "use global config"
  buyAmountEth: text("buy_amount_eth"),
  slippagePercent: text("slippage_percent"),
  maxGasGwei: text("max_gas_gwei"),
  autoSell: boolean("auto_sell"),
  takeProfitPercent: text("take_profit_percent"),
  stopLossPercent: text("stop_loss_percent"),
});

export const insertCreatorSchema = createInsertSchema(creatorsTable).omit({
  addedAt: true,
  totalSniped: true,
});
export type InsertCreator = z.infer<typeof insertCreatorSchema>;
export type Creator = typeof creatorsTable.$inferSelect;
