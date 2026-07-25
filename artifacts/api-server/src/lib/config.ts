import { db, botConfigTable, DEFAULT_CONFIG } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface AppConfig {
  buyAmountEth: string;
  slippagePercent: number;
  maxGasGwei: number;
  watchMode: "whitelist" | "all";
  enabled: boolean;
  minLiquidityEth: number | null;
  autoSell: boolean;
  takeProfitPercent: number | null;
  stopLossPercent: number | null;
  maxBuysPerDay: number | null; // null = no limit
}

function parseNullableNumber(val: string | undefined): number | null {
  if (!val || val === "") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function parseNullableInt(val: string | undefined): number | null {
  if (!val || val === "") return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

export async function loadConfig(): Promise<AppConfig> {
  const rows = await db.select().from(botConfigTable);
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }

  return {
    buyAmountEth: map.buyAmountEth ?? DEFAULT_CONFIG.buyAmountEth,
    slippagePercent: parseFloat(map.slippagePercent ?? DEFAULT_CONFIG.slippagePercent),
    maxGasGwei: parseFloat(map.maxGasGwei ?? DEFAULT_CONFIG.maxGasGwei),
    watchMode: (map.watchMode ?? DEFAULT_CONFIG.watchMode) as "whitelist" | "all",
    enabled: (map.enabled ?? DEFAULT_CONFIG.enabled) === "true",
    minLiquidityEth: parseNullableNumber(map.minLiquidityEth),
    autoSell: (map.autoSell ?? DEFAULT_CONFIG.autoSell) === "true",
    takeProfitPercent: parseNullableNumber(map.takeProfitPercent),
    stopLossPercent: parseNullableNumber(map.stopLossPercent),
    maxBuysPerDay: parseNullableInt(map.maxBuysPerDay),
  };
}

export async function saveConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  const stringified: Record<string, string> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (v === null || v === undefined) {
      stringified[k] = "";
    } else {
      stringified[k] = String(v);
    }
  }

  for (const [key, value] of Object.entries(stringified)) {
    await db
      .insert(botConfigTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: botConfigTable.key, set: { value } });
  }

  return loadConfig();
}
