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
 * Idempotent schema migrations — run on every boot, safe to re-apply.
 */
async function applyMigrations(): Promise<void> {
  logger.info("Applying DB migrations…");
  await pool.query(`
    ALTER TABLE creators
      ADD COLUMN IF NOT EXISTS buy_amount_eth      TEXT,
      ADD COLUMN IF NOT EXISTS slippage_percent    TEXT,
      ADD COLUMN IF NOT EXISTS max_gas_gwei         TEXT,
      ADD COLUMN IF NOT EXISTS auto_sell            BOOLEAN,
      ADD COLUMN IF NOT EXISTS take_profit_percent  TEXT,
      ADD COLUMN IF NOT EXISTS stop_loss_percent    TEXT,
      ADD COLUMN IF NOT EXISTS max_buys_per_day     INTEGER;
  `);
  logger.info("DB migrations applied");
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
