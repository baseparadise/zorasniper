# Zora Sniper — Technical README

This document is a deep technical reference for maintaining this codebase. It is
written for whoever (human or AI) picks this project up next and needs to
understand *how the whole system behaves*, not just how to boot it. The
top-level marketing-style summary that used to live here has been folded in
below; everything past "Quick Start" is architecture and behavior detail.

If you are an AI maintainer: read this file in full before changing anything
in `artifacts/api-server/src/bot/trader.ts`, `sniper.ts`, or
`artifacts/api-server/src/routes/manual.ts`. Those three files contain almost
all of the trading logic and have several deliberate, non-obvious design
decisions (documented in "Design decisions & why" below) that are easy to
accidentally revert.

## What this app does

A single Node.js/Express service (deployed as one Railway service) that:

1. **Watches the Zora Coins factory contract on Base** for new coin
   deployments in real time (WebSocket `eth_subscribe` via `viem`).
2. **Auto-buys** coins deployed by whitelisted creator wallets ("the sniper").
3. Lets the user **manually buy/sell** any Base ERC-20 token from the UI,
   independent of the sniper.
4. **Monitors open positions** for take-profit / stop-loss targets and
   auto-sells when hit.
5. Serves a **React dashboard** (bot status, trade history, P&L, creator
   whitelist, settings, manual trade console) as static files from the same
   Express server.

There is no multi-tenancy: one wallet, one password, one bot. All state is
either in the Postgres DB, in-memory (`botState`, active monitor timers), or
env vars.

## Quick Start

```bash
pnpm install
cp .env.example .env         # fill in ALCHEMY_RPC_URL, WALLET_PRIVATE_KEY, WEB_PASSWORD, DATABASE_URL
pnpm --filter @workspace/db run push       # push Drizzle schema to Postgres
pnpm --filter @workspace/api-server run dev   # API on :8080 (or $PORT)
pnpm --filter @workspace/zora-sniper run dev  # Vite dev server for the frontend
```

Required env vars: `ALCHEMY_RPC_URL` (must be `wss://` — it's rewritten to
`https://`/`ws://` internally as needed per-client), `WALLET_PRIVATE_KEY`,
`WEB_PASSWORD`, `DATABASE_URL`. Optional: `ALLOWED_ORIGIN`, `ZORA_API_KEY` /
`ZORA_API_KEYS` (comma-separated, round-robin), `BASESCAN_API_KEY`,
`GMGN_API_KEY`, `COINGECKO_API_KEY`, `ZERION_API_KEY`,
`ZORA_FACTORY_ADDRESS` (override), `LIFI_API_KEY`.

Production build/run is Docker-based (see `Dockerfile`/`railway.json`):
codegen → build frontend → build backend → `node artifacts/api-server/dist/index.mjs`,
serving the built frontend as static files from the same Express app.

## Monorepo layout

```
artifacts/api-server/     Express backend (this is "the app")
artifacts/zora-sniper/    React + Vite frontend
lib/db/                   Drizzle schema + Postgres client (@workspace/db)
lib/api-zod/              Zod schemas for request/response validation, shared by both ends
lib/api-spec/             OpenAPI spec + Orval codegen config
lib/api-client-react/     Generated React Query hooks from the OpenAPI spec (frontend uses these)
```

The frontend never imports backend code directly; it calls the REST API
through generated hooks in `lib/api-client-react`, whose types come from
`lib/api-zod` via `lib/api-spec`'s Orval codegen. If you change a route's
request/response shape, update the Zod schema in `lib/api-zod` and re-run
codegen — do not hand-edit generated client files.

## Data model (`lib/db/src/schema/`)

**`trades`** — every buy attempt, sniper or manual, is one row. There is no
separate "positions" table; a "position" is just a trade row with
`status IN ('confirmed', 'selling')`.
- `status`: `pending → confirmed → selling → sold`, or `failed`, or `skipped`.
  - `pending`: buy tx submitted, not yet confirmed on-chain.
  - `confirmed`: buy succeeded, position open, TP/SL monitor may be running.
  - `selling`: a sell has been claimed/started (see atomic-claim pattern
    below) — this is the lock that prevents double-sells.
  - `sold`: sell tx confirmed. `sellTxHash`, `sellAmountEth`, `pnlEth` set.
  - `failed`: buy or sell tx reverted/errored. `failReason` set.
  - `skipped`: the sniper detected a matching deploy but did not attempt a
    buy (bot disabled, daily limit hit, or duplicate event) — recorded purely
    so the dashboard can show "we saw this, here's why we didn't buy."
- `source`: `'sniper'` (auto-triggered by `handleCoinCreated`) or `'manual'`
  (user clicked Buy in the Trade UI). Both share `executeBuy`-family logic
  but have separate code paths (`trader.ts` vs `manual.ts`) because manual
  buys need to return quickly to the HTTP request while sniper buys are
  fire-and-forget from a WebSocket event handler.
- `entryPriceEth`: ETH spent ÷ tokens received. Stored for display only.
- `entryValueUsdc`: USDC value of the position *right after the buy*,
  computed via a sell-direction quote. **This is the actual TP/SL cost
  basis**, not `entryPriceEth` — see "Why value-based TP/SL" below.
- `takeProfitPercent`/`stopLossPercent`: captured onto the trade row at buy
  time (a snapshot of config/creator-override at that moment), so editing
  global settings later doesn't retroactively change an open position's
  targets unless the user explicitly edits that position via
  `PUT /positions/:id/tpsl`.

**`creators`** — the sniper whitelist. `enabled` toggles whether a wallet is
sniped. Optional per-wallet override columns (`buyAmountEth`,
`slippagePercent`, `maxGasGwei`, `autoSell`, `takeProfitPercent`,
`stopLossPercent`, `maxBuysPerDay`) are `null` by default, meaning "inherit
global config" — resolved in `sniper.ts`'s `handleCoinCreated` as
`creatorRow?.X ?? config.X`.

**`bot_config`** — a plain key/value table (`DEFAULT_CONFIG` in
`botConfig.ts` lists every key and its default). `loadConfig()`/`saveConfig()`
in `lib/config.ts` marshal this into/from the typed `AppConfig` interface.
Everything is stored as `TEXT`; numbers and booleans are stringified and
parsed back out (`""` means "not set" / null, not `0`).

Migrations are **not** Drizzle-managed at runtime — see "Migration system"
below.

## Server bootstrap (`src/index.ts`)

1. Reads `PORT` from env (hard-required; throws if missing — this is
   deliberate so a misconfigured Railway service fails loudly instead of
   silently binding to a wrong default).
2. Creates the HTTP server, attaches the WS server (`startWsServer`), then
3. Runs `applyMigrations()` — a hand-rolled migration runner (see below) —
   and only after it resolves does it call `server.listen(port)`.
4. After listening, kicks off `recoverTpSlMonitors()` (manual/Li.Fi-priced
   positions) and `recoverSniperTpSlMonitors()` (sniper/Zora-priced
   positions) to re-attach TP/SL watchers for positions that were `confirmed`
   before a restart/redeploy. These are two separate functions because
   manual and sniper positions use different price-probe strategies.

### Migration system

There is **no Drizzle migration folder** in the deploy path. `applyMigrations()`
in `index.ts` runs a fixed, append-only array of raw SQL `ALTER TABLE ...
ADD COLUMN IF NOT EXISTS` statements, tracked in a `_schema_migrations` table
so each one runs exactly once per database. **To add a schema change: add a
new entry to the `migrations` array in `index.ts` with a new sequential name
(`00N_description`) and idempotent SQL — do not edit past entries.** This
exists because `lib/db/src/schema/*.ts` (the Drizzle schema, used for
typing/`drizzle-kit push` in dev) had drifted from what migrations actually
ran in production more than once (see the comments on migrations 003 and 004
in `index.ts` for the incidents that caused this pattern to be adopted).

## The sniper (`src/bot/sniper.ts`)

`startSniper()` / `stopSniper()` are called from `POST /api/bot/start` and
`/stop`. When running:

- Opens a `viem` `webSocket` public client against `ALCHEMY_RPC_URL` and
  calls `watchContractEvent` against the Zora Coins factory
  (`ZORA_FACTORY_ADDRESS`, default `0x77777...5baF3`), with **no `eventName`
  filter** — it listens for all four coin-creation event shapes the factory
  can emit (`CoinCreated`, `CoinCreatedV4`, `CreatorCoinCreated`,
  `TrendCoinCreated`; the ABI for all four is inlined in `sniper.ts` since
  viem needs exact event signatures). `TrendCoinCreated` has no `name` field
  (synthesized as `[Trend] ${symbol}`) and no `payoutRecipient` (falls back
  to `caller`).
- On reconnection loss (`onError`), reconnects with exponential backoff
  capped at 60s, but only while `botState.get().running` is still true (a
  manual stop cancels any pending reconnect).
- Every matching log goes through `handleCoinCreated`, which:
  1. Resolves `creatorAddr` (lowercased `payoutRecipient ?? caller`).
  2. If `config.watchMode === "all"`, snipes everything; otherwise does a
     case-insensitive lookup in `creators` and only proceeds if
     `creatorRow.enabled`.
  3. If bot is globally disabled (`config.enabled === false`) but the
     creator *is* whitelisted, records a `skipped` trade row so the UI shows
     "we saw this deploy" — doesn't just silently drop it.
  4. Resolves effective per-creator overrides vs. global config.
  5. Enforces `maxBuysPerDay` (UTC midnight window, excludes `failed`/
     `skipped` trades from the count) via `countTodayBuys`.
  6. **Dedup guard**: before firing a buy, checks for any existing
     `pending`/`confirmed` trade row for the same token address, and skips
     (records as `skipped`) if found. This exists because a WebSocket
     reconnect can replay recent logs, and without this guard the same
     coin-creation event could trigger two buys.
  7. Calls `executeBuy` (in `trader.ts`) **fire-and-forget** (not awaited) so
     the event loop keeps listening for the next log. TP/SL targets are only
     passed through if `config.autoSell` is true — this flag used to be
     ignored here (a real bug: turning off "Auto-Sell" in Settings did
     nothing if TP/SL numbers were still stored from a previous session).

`minLiquidityEth` in config exists but is **intentionally not checked** at
snipe time — the comment in `handleCoinCreated` explains this is because the
pool has no liquidity data available at the instant of the creation event.
It's reserved for future post-deployment guards; don't be surprised that it's
unused in the buy path.

## Manual trading (`src/routes/manual.ts`)

This file backs the "Trade" page: token lookup, buy, sell, position list,
and TP/SL editing for manually-opened positions. It duplicates several
helpers from `trader.ts` (`toHex`, `fetchZoraQuote`, key rotation, etc.)
rather than importing them — this is existing duplication, not accidental;
the two files evolved to serve slightly different call shapes (fire-and-
forget event-driven vs. request/response), so consolidate carefully if you
ever merge them (check both call sites' error-handling expectations first).

### Buy: `POST /trades/manual-buy`

Inserts a trade row immediately with placeholder `tokenName`/`tokenSymbol`/
`entryPriceEth` and **returns the response right away** — token
name/symbol lookup and the Zora price probe run afterward in a background
`IIFE` that patches the row once resolved. This was a deliberate speed fix:
those reads are cosmetic (only used for display) and were previously
blocking the HTTP response, adding latency to what the user perceives as "I
clicked Buy and nothing happened for N seconds."

`runBuy` tries Zora Quote API first (`executeViaZora`); if Zora can't route
the token (not a Zora Coin, or returns no quote after 3 retries with 5s
backoff — used because freshly-deployed pools aren't immediately quotable),
falls back to Li.Fi (`executeViaLiFi`). Both paths: fetch quote → estimate
EIP-1559 gas → send tx → wait for receipt → diff `balanceOf` to get actual
tokens received → probe entry value in USDC (`fetchZoraPriceProbe` /
`fetchPositionValueUsdc`) → update the trade row → if TP/SL was specified,
call `monitorTpSlSniper` (yes, manual trades use the same monitor function
as sniper trades — see "TP/SL monitor" below).

### Sell: `POST /positions/:id/sell`

This route was rewritten mid-project to fix a **double-approval bug**: the
old version read the trade row, decided the route (0x vs Li.Fi), then
executed — with no atomicity, so a double-click (or two near-simultaneous
requests) could pass the "is it already selling?" check twice before either
write landed, causing token approvals to be requested against **both** 0x's
AllowanceHolder contract and Li.Fi's router even though only one sale would
ultimately succeed.

Fix pattern — **atomic DB claim**: the row is claimed with a single
conditional `UPDATE trades SET status='selling' WHERE id=$1 AND
status='confirmed' RETURNING *`. If zero rows come back, another request
already claimed it (or it wasn't sellable), and this request returns
immediately with a 4xx. Only the request that wins the claim proceeds. The
response is sent **right after the claim succeeds** (optimistic — the UI
shows "selling…"); wallet-address derivation, the `balanceOf` read, and the
actual `runMarketSell` call happen afterward in the background. If the sell
ultimately fails, the trade is released back to `status='confirmed'` with
`failReason` set, so the user can retry.

`runMarketSell` tries **0x AllowanceHolder** first (`get0xAllowanceHolderQuote`
+ traditional `approve()` if needed), and falls back to **Li.Fi**
(`getLiFiQuote` + `ensureApproval`) only if 0x fails. **Deliberately not
using 0x's Permit2/EIP-712 flow** — it previously failed gas estimation on
Zora/Uniswap-V4-pooled tokens; AllowanceHolder's plain `approve()` +
`transferFrom` flow is more broadly compatible. Do not "simplify" this back
to Permit2 without re-testing against several live Zora Coins.

### `PUT /positions/:id/tpsl`

Updates `takeProfitPercent`/`stopLossPercent` on a trade row and restarts its
`monitorTpSlSniper` watcher with the new thresholds. Safe to call repeatedly
thanks to the generation-token guard described next — restarting no longer
leaves a stale watcher running alongside the new one.

## TP/SL monitor (`trader.ts::monitorTpSlSniper`)

One `setInterval`-based watcher per open position (keyed by trade id), polls
the current position value and auto-sells via `executeZoraSell` when a
target is crossed.

**Pricing**: uses the Zora `/coin` market-price endpoint × current token
balance (i.e., recomputes position *value* in USDC), **not** a live
sell-quote price. This is intentional and must stay consistent with how
`entryValueUsdc` was computed and how `/positions` computes live value —
using a sell-quote price here would introduce price-impact skew that
doesn't match the stored cost basis, causing false TP/SL triggers.

**Concurrency guard**: a module-level `monitorGeneration: Map<number,
symbol>` assigns each call to `monitorTpSlSniper` for a given trade id a
unique generation token. On every poll tick, and before acting, the monitor
checks whether its own token is still the current one for that trade id; if
not (a newer call replaced it — e.g. the user edited TP/SL, which calls
`monitorTpSlSniper` again for the same id), it exits quietly.
`releaseGeneration()` is called on every terminal exit (position sold,
position no longer confirmed, error) to clean up the map. **This exists
because editing TP/SL used to spawn a second monitor without killing the
first**, leaving two intervals racing against stale vs. fresh thresholds —
whichever fired first would sell, sometimes at the old target.

**Recovery on restart**: `recoverSniperTpSlMonitors()` (sniper-sourced
positions) and `manual.ts`'s `recoverTpSlMonitors()` (manual positions) both
run at server boot and re-query `trades` for `status='confirmed'` rows that
have TP/SL set, re-attaching a monitor for each. **Known limitation**: any
trade missing `entryValueUsdc` (rows from before that column existed, or
where the post-buy price probe failed) is permanently excluded from
recovery — there's no cost basis to compare against, and no backfill job
exists. This was a known, accepted gap at the time of writing (not a bug to
silently "fix" by guessing a cost basis).

## Swap execution & routing summary

| Direction | Primary | Fallback | Why |
|---|---|---|---|
| Buy (sniper + manual) | Zora Quote API (`/quote`, ETH→ERC20) | Li.Fi | Zora Coins route best through Zora's own aggregator when the pool is fresh/Zora-specific |
| Sell (manual `/positions/:id/sell`, and TP/SL auto-sell) | 0x AllowanceHolder (`/swap/allowance-holder/quote`) | Li.Fi | 0x AllowanceHolder is broadly compatible; **not** using 0x Permit2 (gas-estimation failures on Zora/Uniswap-V4 tokens) |

All three integrations (`lib/zerox.ts`, `lib/lifi.ts`, and the Zora calls
inlined in `trader.ts`/`manual.ts`) return raw calldata that this app signs
and sends itself via `viem` (`createWalletClient` + `privateKeyToAccount`
from `WALLET_PRIVATE_KEY`) — none of them are used as hosted-wallet/relayer
services; this app always holds the key and pays its own gas.

`ZORA_API_KEY`/`ZORA_API_KEYS` (comma-separated) are round-robin rotated
(`nextZoraKey()`, duplicated identically in `trader.ts` and `manual.ts`) to
spread load across multiple keys if provided; the Zora API works without a
key too, just at lower rate limits.

## Auth & sessions (`src/middlewares/auth.ts`, `src/routes/auth.ts`)

Single shared password (`WEB_PASSWORD` env var) — there are no user
accounts. `POST /api/auth/login` compares the submitted password against
`WEB_PASSWORD` using `timingSafeEqual` (constant-time, to avoid timing-based
enumeration) and, on success, creates an opaque random session token stored
in an **in-memory** `Map<token, expiryTimestamp>` (`sessions` in
`auth.ts`) — sessions do **not** survive a server restart/redeploy; all
users are logged out. The token is set as an `httpOnly`, `sameSite=lax`
cookie (`zs_session`), `secure` in production, 30-day TTL.

`app.ts` mounts `publicRouter` (health, login, logout) with no auth, then
`authMiddleware` as a blanket gate, then `protectedRouter` (everything else).
The WebSocket server (`bot/ws.ts`) independently re-validates the same
session cookie (parsed by hand from the raw `Cookie` header, since `ws`
upgrade requests don't go through Express middleware) before accepting a
connection.

## Real-time updates (`src/bot/ws.ts`)

A single `WebSocketServer` mounted at `/api/ws` on the same HTTP server.
`broadcast(type, payload)` fans a JSON `{ type, payload }` message out to
every currently-open client — there's no per-client filtering or
subscriptions. Emitted event types include `status` (bot start/stop/balance
refresh), `event` (coin_created, limit_reached), `trade` (new/updated trade
row), and `error`. The frontend's `Trade.tsx`/`Dashboard.tsx` listen for
`trade`/`status` messages to update the UI live without polling — though
`Trade.tsx` also polls `/positions` on an interval as a fallback (a stale
code comment there claims the WS event "fires every ~15s"; the actual poll
interval used is 5s — cosmetic inaccuracy only, not a functional bug).

## Frontend (`artifacts/zora-sniper/src/`)

Vite + React + TailwindCSS + shadcn/ui, client-side routed with `wouter`
(`App.tsx`). `App.tsx` gates the whole app behind `GET /api/auth/check` on
mount (`loading` → `authenticated`/`unauthenticated`); unauthenticated shows
`Login.tsx`, otherwise renders `Layout` + the router:

- `Dashboard.tsx` — bot status, live stats, recent trades, top creators.
- `Trade.tsx` — manual buy/sell console + open-positions list
  (`PositionCard` component). Buy/Sell buttons are `disabled={isSelling}` /
  equivalent in-flight flags — the double-click UI guard exists but the
  double-approval bug (fixed above) was actually a server-side race, not a
  missing frontend debounce.
- `Trades.tsx` — full trade history table.
- `Creators.tsx` — whitelist CRUD + per-creator override editing.
- `Settings.tsx` — global `bot_config` editor. Note: when the user disables
  Auto-Sell, the form explicitly nulls out `takeProfitPercent`/
  `stopLossPercent` before submitting, so stale hidden values from a
  previous "auto-sell on" state aren't silently resubmitted.
- `not-found.tsx` — 404 fallback.

Data fetching goes through generated hooks from `lib/api-client-react`
(React Query under the hood), typed from `lib/api-zod` — do not hand-write
`fetch()` calls for existing endpoints; add/adjust the Zod schema and
OpenAPI spec, run codegen, and consume the generated hook.

## Design decisions & why (condensed)

- **Value-based TP/SL, not price-based**: comparing live *position value*
  (balance × market price) against `entryValueUsdc` avoids skew from sell
  quotes' own price impact, which previously caused TP/SL comparisons to be
  off by a large factor on thin-liquidity tokens.
- **Atomic DB claim over locks/queues** for both the sell-claim and (by the
  same pattern) anywhere else a "only one caller should proceed" situation
  arises: a single conditional `UPDATE ... WHERE status = 'X' RETURNING`
  is enough given Postgres's row-level locking, and keeps the code
  synchronous/simple rather than introducing an external queue.
- **In-memory generation tokens over a job queue** for monitor lifecycle
  (TP/SL): the app has exactly one process and modest concurrency needs, so
  a `Map<id, symbol>` guard is proportionate; don't over-engineer this into
  a queue system unless the app moves to multi-process/multi-instance.
- **Non-critical work moved after the HTTP response** (token name/symbol
  lookups, price probes, balance pre-checks) wherever it doesn't affect
  trade correctness — only UI feedback timing. Quote-fetch, simulate,
  approve, and wait-for-receipt logic were deliberately left synchronous
  and blocking; those are correctness/safety-critical and should not be
  raced or deferred.
- **No Alchemy `blockNumber` pinning** on post-buy `balanceOf` reads, and
  dashboard wallet-balance polling uses the public Base RPC rather than
  Alchemy — both were changed after hitting Alchemy "resource not found"
  errors when pinning to a block number that Alchemy's archive tier hadn't
  indexed yet.

## Known non-blocking issues (as of last audit)

- Trades missing `entryValueUsdc` (pre-migration or failed price probe at
  buy time) are permanently excluded from TP/SL recovery on restart — no
  backfill exists; accepted, not a bug to silently patch.
- `PositionCard`'s `livePnlPositive`/`livePnlZero` thresholds have a minor
  overlap at the boundary (cosmetic color glitch right at breakeven, not a
  functional trading issue).
- A stale comment in `Trade.tsx` claims the WS `position_update` event
  "fires every ~15s"; the actual polling fallback interval is 5s.

## Security notes

- Private key lives only in `WALLET_PRIVATE_KEY` (env), never persisted to
  the DB or logged.
- Use a dedicated trading wallet with limited funds — this bot can execute
  buys and sells autonomously (TP/SL) without a human in the loop once
  configured.
- CORS is locked to `ALLOWED_ORIGIN` in production; in dev it reflects the
  request origin (`credentials: true`, required for the session cookie to
  work cross-origin during local frontend/backend split dev).
