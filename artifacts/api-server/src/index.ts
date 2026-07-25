import { createServer } from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { startWsServer } from "./bot/ws";
import { privateKeyToAccount } from "viem/accounts";
import { botState } from "./bot/state";

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

// Derive wallet address from private key at startup — no RPC call needed.
// This ensures the dashboard always shows the correct address regardless of bot state.
try {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (key) {
    const normalizedKey = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
    const account = privateKeyToAccount(normalizedKey);
    botState.update({ walletAddress: account.address });
    logger.info({ address: account.address }, "Wallet address loaded from private key");
  } else {
    logger.warn("WALLET_PRIVATE_KEY not set — wallet address will be unavailable");
  }
} catch (err) {
  logger.error({ err }, "Failed to derive wallet address from WALLET_PRIVATE_KEY — check key format");
}

const server = createServer(app);

startWsServer(server);

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
