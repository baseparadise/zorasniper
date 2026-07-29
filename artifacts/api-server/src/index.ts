import { createServer } from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { startWsServer } from "./bot/ws";
import { pool } from "@workspace/db";
import { recoverTpSlMonitors } from './routes/manual';
import { recoverSniperTpSlMonitors } from './bot/trader';

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Lightweight migration runner.
 *
 * Bug #7 fix: the old approach ran bare ALTER TABLE statements on every single
 * boot. Even with IF NOT EXISTS guards, PostgreSQL still locks the table and
 * queries the system catalog each time, adding unnecessary latency and log
 * noise. This version creates a _schema_migrations tracking table and only
 * applies each migration once — subsequent boots skip straight to startup.
 *
 * How to add a new migration:
 *   1. Append an entry to the `migrations` array below.
 *   2. Use a sequential name like "003_<short_description>".
 *   3. Keep the IF NOT EXISTS / DO NOTHING guards for safety.
 */
async function applyMigrations(): Promise<void> {
  logger.info("Checking DB migrations…");

  // Tracking table — created once, never dropped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      name       TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows: applied } = await pool.query<{ name: string }>(
    `SELECT name FROM _schema_migrations`,
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  const migrations: Array<{ name: string; sql: string }> = [
    {
      // Added per-wallet sniper override columns to creators table.
      name: "001_creators_per_wallet_settings",
      sql: `
        ALTER TABLE creators
          ADD COLUMN IF NOT EXISTS buy_amount_eth      TEXT,
          ADD COLUMN IF NOT EXISTS slippage_percent    TEXT,
          ADD COLUMN IF NOT EXISTS max_gas_gwei         TEXT,
          ADD COLUMN IF NOT EXISTS auto_sell            BOOLEAN,
          ADD COLUMN IF NOT EXISTS take_profit_percent  TEXT,
          ADD COLUMN IF NOT EXISTS stop_loss_percent    TEXT,
          ADD COLUMN IF NOT EXISTS max_buys_per_day     INTEGER
      `,
    },
    {
      // Added fail_reason column to trades table for error diagnostics.
      name: "002_trades_fail_reason",
      sql: `ALTER TABLE trades ADD COLUMN IF NOT EXISTS fail_reason TEXT`,
    },
    {
      // Added zora_profile_url column to creators table.
      // Bug: this column was in the TypeScript schema from the start but was
      // never included in any migration. Drizzle generates explicit column
      // names in SELECT and UPDATE RETURNING, so every read/update on the
      // creators table was failing with "column does not exist".
      name: "003_creators_zora_profile_url",
      sql: `ALTER TABLE creators ADD COLUMN IF NOT EXISTS zora_profile_url TEXT`,
    },
    {
      // Added extended trade columns for sell tracking and manual buy features.
      // These columns exist in the TypeScript schema but were never migrated,
      // so every SELECT on tradesTable (which enumerates columns explicitly)
      // was failing with DrizzleQueryError "column does not exist".
      name: "004_trades_extended_fields",
      sql: `
        ALTER TABLE trades
          ADD COLUMN IF NOT EXISTS sell_tx_hash       TEXT,
          ADD COLUMN IF NOT EXISTS sell_amount_eth    TEXT,
          ADD COLUMN IF NOT EXISTS pnl_eth            TEXT,
          ADD COLUMN IF NOT EXISTS block_number       BIGINT,
          ADD COLUMN IF NOT EXISTS source             TEXT NOT NULL DEFAULT 'sniper',
          ADD COLUMN IF NOT EXISTS take_profit_percent TEXT,
          ADD COLUMN IF NOT EXISTS stop_loss_percent  TEXT,
          ADD COLUMN IF NOT EXISTS entry_price_eth    TEXT
      `,
    },
    {
      // Add entry_value_usdc column for value-based TP/SL tracking.
      // Replaces the old entry_price_eth approach for sniper monitors:
      // stores USDC value of the token position immediately after buy
      // (via sell-direction quote), so the monitor compares position value
      // rather than price-per-token (which was 31x off due to probe impact).
      name: "005_trades_entry_value_usdc",
      sql: `ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_value_usdc TEXT`,
    },
  ];

  let ran = 0;
  for (const migration of migrations) {
    if (appliedSet.has(migration.name)) continue;

    logger.info({ migration: migration.name }, "Applying migration");
    await pool.query(migration.sql);
    await pool.query(
      `INSERT INTO _schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`,
      [migration.name],
    );
    logger.info({ migration: migration.name }, "Migration applied");
    ran++;
  }

  if (ran === 0) {
    logger.info("DB migrations — all up to date, nothing to run");
  } else {
    logger.info({ count: ran }, "DB migrations complete");
  }
}

const server = createServer(app);

startWsServer(server);

applyMigrations()
  .then(() => {
    server.listen(port, () => {
      logger.info({ port }, 'Server listening');
    });

    // Restart TP/SL monitors for confirmed trades that survived a redeploy.
    // Manual trades (Li.Fi monitor) and sniper trades (Zora API monitor)
    // are recovered separately because they use different price probes.
    recoverTpSlMonitors().catch((err) =>
      logger.error({ err }, 'Manual TP/SL startup recovery failed'),
    );
    recoverSniperTpSlMonitors().catch((err) =>
      logger.error({ err }, 'Sniper TP/SL startup recovery failed'),
    );

    server.on("error", (err) => {
      logger.error({ err }, "Server error");
      process.exit(1);
    });
  })
  .catch((err) => {
    logger.error({ err }, "Migration failed — aborting startup");
    process.exit(1);
  });
