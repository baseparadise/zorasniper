# Zora Sniper

Automated sniper bot web app for Zora Coins on Base blockchain. The bot listens for new coin launches from whitelisted creators and auto-buys them.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + bot (port 8080)
- `pnpm --filter @workspace/zora-sniper run dev` — run the frontend dev server
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `ALCHEMY_RPC_URL`, `WALLET_PRIVATE_KEY`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + TailwindCSS + React Query
- API: Express 5 + WebSocket (ws)
- Blockchain: viem (Base mainnet)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (zod/v4), drizzle-zod
- API codegen: Orval (from OpenAPI spec)

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for all API contracts)
- `lib/db/src/schema/` — Database schema (creators, trades, botConfig tables)
- `artifacts/api-server/src/bot/` — Core bot logic (sniper.ts, trader.ts, state.ts, ws.ts)
- `artifacts/api-server/src/routes/` — API route handlers
- `artifacts/api-server/src/lib/config.ts` — Bot config loader/saver
- `artifacts/zora-sniper/src/` — React frontend

## Architecture decisions

- Bot state is in-memory (BotStateManager/EventEmitter) — fast, no DB round-trip for status checks
- WebSocket at `/api/ws` broadcasts real-time events to all connected clients
- Bot config is stored as key-value rows in DB (flexible, no migration needed for new settings)
- Railway deployment: Express serves both API + built frontend static files (single service)
- Zora factory address is configurable via `ZORA_FACTORY_ADDRESS` env var

## Gotchas

- ALCHEMY_RPC_URL must use `wss://` (WebSocket) for blockchain event listening, not `https://`
- Always run `pnpm --filter @workspace/api-spec run codegen` after changing `openapi.yaml`
- The DB schema push (`pnpm --filter @workspace/db run push`) is required before the API server starts
- For Railway production: Railway auto-provides `DATABASE_URL` when you add a PostgreSQL service

## User preferences

- Deploying to Railway (not Replit Deployments)
- Starting with Zora protocol; Clanker and PumpFun planned for later
- GitHub repo: https://github.com/baseparadise/zora-sniper
