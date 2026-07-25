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
});

export const insertCreatorSchema = createInsertSchema(creatorsTable).omit({
  addedAt: true,
  totalSniped: true,
});
export type InsertCreator = z.infer<typeof insertCreatorSchema>;
export type Creator = typeof creatorsTable.$inferSelect;
