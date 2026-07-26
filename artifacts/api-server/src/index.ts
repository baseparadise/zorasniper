import { createServer } from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { startWsServer } from "./bot/ws";
import { pool } from "@workspace/db";

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
      logger.info({ port }, "Server listening");
    });

    server.on("error", (err) => {
      logger.error({ err }, "Server error");
      process.exit(1);
    });
  })
  .catch((err) => {
    logger.error({ err }, "Migration failed — aborting startup");
    process.exit(1);
  });
