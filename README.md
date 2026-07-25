# Zora Sniper

Automated sniper bot for Zora Coins on Base blockchain. Monitors the Zora Coin factory for new token launches and auto-buys when a whitelisted creator deploys.

## Features

- **Real-time monitoring** — Listens to Base blockchain via WebSocket RPC
- **Creator whitelist** — Only snipe coins from creators you trust
- **Auto buy** — Executes purchase in the same block as the launch
- **Dashboard** — Live bot status, trade history, P&L tracking
- **Configurable** — Buy amount, slippage, gas limit, watch mode

## Stack

- **Frontend**: React + Vite + TailwindCSS
- **Backend**: Node.js + Express 5 + WebSocket
- **Blockchain**: viem (Base mainnet)
- **Database**: PostgreSQL + Drizzle ORM
- **Monorepo**: pnpm workspaces

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project → Deploy from GitHub repo
3. Add a PostgreSQL database service in Railway
4. Set environment variables (see `.env.example`):
   - `ALCHEMY_RPC_URL` — WSS URL from Alchemy (Base Mainnet)
   - `WALLET_PRIVATE_KEY` — Your trading wallet private key
   - `DATABASE_URL` — Auto-provided by Railway PostgreSQL
5. Railway uses `railway.json` — build and start are pre-configured

## Local Development

```bash
# Install dependencies
pnpm install

# Copy env file
cp .env.example .env
# Fill in your values in .env

# Push database schema
pnpm --filter @workspace/db run push

# Start API server (port 8080)
pnpm --filter @workspace/api-server run dev

# Start frontend dev server (separate terminal)
pnpm --filter @workspace/zora-sniper run dev
```

## Configuration

Bot settings can be changed from the **Settings** page in the UI without restarting.

| Setting | Default | Description |
|---------|---------|-------------|
| Buy Amount | 0.01 ETH | ETH spent per snipe |
| Slippage | 5% | Max price impact tolerance |
| Max Gas | 50 gwei | Gas price ceiling |
| Watch Mode | whitelist | `whitelist` = only listed creators, `all` = any new coin |
| Auto Sell | off | Automatically sell at take profit target |

## Supported Protocols

- [x] **Zora Coins** (Base mainnet)
- [ ] Clanker (coming soon)
- [ ] PumpFun (coming soon)

## Security

- Private key is stored in environment variables, never in the database
- Bot only executes buys — no withdrawal access unless the wallet is compromised
- Use a dedicated trading wallet with limited funds
