import { Router, type IRouter } from "express";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  formatUnits,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { db, tradesTable } from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { z } from "zod/v4";

const router: IRouter = Router();

// ── ABI definitions ────────────────────────────────────────────────────────

const ERC20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const ZORA_COIN_BUY_ABI = [
  {
    type: "function",
    name: "buy",
    stateMutability: "payable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "refundRecipient", type: "address" },
      { name: "orderReferrer", type: "address" },
      { name: "comment", type: "string" },
      { name: "expectedMarketType", type: "uint8" },
      { name: "minOrderSize", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

// ── Helpers ────────────────────────────────────────────────────────────────

function getHttpRpcUrl(): string {
  const url = process.env.ALCHEMY_RPC_URL ?? "";
  return url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

function getWalletKey(): `0x${string}` {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) throw new Error("WALLET_PRIVATE_KEY is not set");
  return key.startsWith("0x") ? (key as `0x${string}`) : `0x${key}`;
}

function makePublicClient() {
  return createPublicClient({ chain: base, transport: http(getHttpRpcUrl()) });
}

// ── Background buy executor ────────────────────────────────────────────────

async function runBuy(
  tradeId: number,
  tokenAddress: Address,
  buyAmountEth: string,
  slippagePercent: number,
): Promise<void> {
  try {
    const account = privateKeyToAccount(getWalletKey());
    const publicClient = makePublicClient();
    const walletClient = createWalletClient({ account, chain: base, transport: http(getHttpRpcUrl()) });

    const value = parseEther(buyAmountEth);

    // Simulate to get expected tokens and calculate minOrderSize with slippage
    let minOrderSize = 0n;
    try {
      const { result: expectedTokens } = await publicClient.simulateContract({
        address: tokenAddress,
        abi: ZORA_COIN_BUY_ABI,
        functionName: "buy",
        args: [account.address, account.address, ZERO_ADDRESS, "zora-sniper-manual", 0, 0n, 0n],
        value,
        account,
      });
      const slippageBps = BigInt(Math.round(slippagePercent * 100));
      minOrderSize = (expectedTokens * (10_000n - slippageBps)) / 10_000n;
    } catch (simErr) {
      logger.warn({ simErr, tradeId }, "Simulation failed, proceeding with minOrderSize=0");
    }

    // Execute buy
    const hash = await walletClient.writeContract({
      address: tokenAddress,
      abi: ZORA_COIN_BUY_ABI,
      functionName: "buy",
      args: [account.address, account.address, ZERO_ADDRESS, "zora-sniper-manual", 0, minOrderSize, 0n],
      value,
    });

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === "success") {
      const gasUsedEth = formatEther(receipt.gasUsed * receipt.effectiveGasPrice);

      // Determine token amount received — read from logs or fallback to last simulation result
      let tokenAmount = "0";
      if (minOrderSize > 0n) tokenAmount = formatUnits(minOrderSize, 18);

      // Entry price: ETH paid / tokens received
      const tokensNum = parseFloat(tokenAmount);
      const ethNum = parseFloat(buyAmountEth);
      const entryPrice = tokensNum > 0 ? (ethNum / tokensNum).toFixed(18) : "0";

      await db
        .update(tradesTable)
        .set({
          status: "confirmed",
          txHash: hash,
          gasUsedEth,
          tokenAmount,
          entryPriceEth: entryPrice,
        })
        .where(eq(tradesTable.id, tradeId));

      logger.info({ tradeId, hash, gasUsedEth }, "Manual buy confirmed");
    } else {
      await db
        .update(tradesTable)
        .set({ status: "failed", failReason: "Transaction reverted" })
        .where(eq(tradesTable.id, tradeId));
      logger.warn({ tradeId, hash }, "Manual buy tx reverted");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(tradesTable)
      .set({ status: "failed", failReason: msg.slice(0, 500) })
      .where(eq(tradesTable.id, tradeId));
    logger.error({ err, tradeId }, "Manual buy execution failed");
  }
}

// ── TP/SL background monitor ───────────────────────────────────────────────

async function monitorTpSl(
  tradeId: number,
  tokenAddress: Address,
  entryPriceEth: number,
  takeProfitPercent: number | null,
  stopLossPercent: number | null,
  buyAmountEth: string,
): Promise<void> {
  if (!takeProfitPercent && !stopLossPercent) return;

  const publicClient = makePublicClient();
  const PROBE_ETH = parseEther("0.0001");

  let probeAccount: Address;
  try {
    probeAccount = privateKeyToAccount(getWalletKey()).address;
  } catch {
    probeAccount = ZERO_ADDRESS;
  }

  const tpPrice = takeProfitPercent ? entryPriceEth * (1 + takeProfitPercent / 100) : null;
  const slPrice = stopLossPercent ? entryPriceEth * (1 - stopLossPercent / 100) : null;

  logger.info({ tradeId, entryPriceEth, tpPrice, slPrice }, "Starting TP/SL monitor");

  const INTERVAL_MS = 15_000; // check every 15s
  const MAX_DURATION_MS = 24 * 60 * 60 * 1000; // max 24h
  const startAt = Date.now();

  while (Date.now() - startAt < MAX_DURATION_MS) {
    await new Promise(r => setTimeout(r, INTERVAL_MS));

    // Re-check trade status — if already sold/failed, stop
    const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, tradeId));
    if (!trade || !["confirmed"].includes(trade.status)) break;

    // Estimate current price via probe simulation
    let currentPrice = entryPriceEth;
    try {
      const { result: probeTokens } = await publicClient.simulateContract({
        address: tokenAddress,
        abi: ZORA_COIN_BUY_ABI,
        functionName: "buy",
        args: [probeAccount, probeAccount, ZERO_ADDRESS, "price-probe", 0, 0n, 0n],
        value: PROBE_ETH,
        account: probeAccount,
      });
      if (probeTokens > 0n) {
        currentPrice = 0.0001 / parseFloat(formatUnits(probeTokens, 18));
      }
    } catch {
      continue;
    }

    const shouldTp = tpPrice !== null && currentPrice >= tpPrice;
    const shouldSl = slPrice !== null && currentPrice <= slPrice;

    if (shouldTp || shouldSl) {
      const reason = shouldTp ? "take_profit" : "stop_loss";
      logger.info({ tradeId, reason, currentPrice, tpPrice, slPrice }, "TP/SL triggered, executing sell");

      try {
        const account = privateKeyToAccount(getWalletKey());
        const walletClient = createWalletClient({ account, chain: base, transport: http(getHttpRpcUrl()) });

        // Get current token balance
        const rawBal = await publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        });

        if (rawBal === 0n) {
          logger.warn({ tradeId }, "No token balance to sell");
          break;
        }

        // Use Zora SDK sell — approximation: sell() on the coin contract
        const ZORA_SELL_ABI = [
          {
            type: "function",
            name: "sell",
            stateMutability: "nonpayable",
            inputs: [
              { name: "tokensSold", type: "uint256" },
              { name: "recipient", type: "address" },
              { name: "refundRecipient", type: "address" },
              { name: "orderReferrer", type: "address" },
              { name: "comment", type: "string" },
              { name: "expectedMarketType", type: "uint8" },
              { name: "minPayoutSize", type: "uint256" },
              { name: "sqrtPriceLimitX96", type: "uint160" },
            ],
            outputs: [{ name: "", type: "uint256" }],
          },
        ] as const;

        const hash = await walletClient.writeContract({
          address: tokenAddress,
          abi: ZORA_SELL_ABI,
          functionName: "sell",
          args: [rawBal, account.address, account.address, ZERO_ADDRESS, reason, 0, 0n, 0n],
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "success") {
          // Estimate ETH recovered — rough: currentPrice * tokensSold
          const tokensNum = parseFloat(formatUnits(rawBal, 18));
          const ethRecovered = (tokensNum * currentPrice).toFixed(6);
          const buyEthNum = parseFloat(buyAmountEth);
          const pnl = (parseFloat(ethRecovered) - buyEthNum).toFixed(6);

          await db
            .update(tradesTable)
            .set({ status: "sold", sellTxHash: hash, sellAmountEth: ethRecovered, pnlEth: pnl })
            .where(eq(tradesTable.id, tradeId));

          logger.info({ tradeId, reason, pnl, hash }, "TP/SL sell confirmed");
        }
      } catch (err) {
        logger.error({ err, tradeId }, "TP/SL sell failed");
      }
      break;
    }
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

const ManualBuyBody = z.object({
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid address"),
  buyAmountEth: z.string().default("0.01"),
  slippagePercent: z.number().min(0).max(50).default(5),
  takeProfitPercent: z.number().nullable().optional(),
  stopLossPercent: z.number().nullable().optional(),
});

router.post("/trades/manual-buy", async (req, res): Promise<void> => {
  const parsed = ManualBuyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }

  const { tokenAddress, buyAmountEth, slippagePercent, takeProfitPercent, stopLossPercent } =
    parsed.data;
  const addr = tokenAddress as Address;
  const publicClient = makePublicClient();

  // Read token name/symbol
  let tokenName = "Unknown";
  let tokenSymbol = "???";
  try {
    const [n, s] = await Promise.all([
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" }),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
    ]);
    tokenName = n as string;
    tokenSymbol = s as string;
  } catch {
    /* proceed with defaults */
  }

  // Determine entry price for TP/SL via probe simulation
  let entryPriceEth = 0;
  try {
    const PROBE_ETH = parseEther("0.0001");
    let probeAccount: Address;
    try {
      probeAccount = privateKeyToAccount(getWalletKey()).address;
    } catch {
      probeAccount = ZERO_ADDRESS;
    }
    const { result: probeTokens } = await publicClient.simulateContract({
      address: addr,
      abi: ZORA_COIN_BUY_ABI,
      functionName: "buy",
      args: [probeAccount, probeAccount, ZERO_ADDRESS, "price-probe", 0, 0n, 0n],
      value: PROBE_ETH,
      account: probeAccount,
    });
    if (probeTokens > 0n) {
      entryPriceEth = 0.0001 / parseFloat(formatUnits(probeTokens, 18));
    }
  } catch {
    /* price probe failed */
  }

  const [tradeRow] = await db
    .insert(tradesTable)
    .values({
      tokenAddress,
      tokenName,
      tokenSymbol,
      creatorAddress: ZERO_ADDRESS,
      buyAmountEth,
      status: "pending",
      source: "manual",
      takeProfitPercent: takeProfitPercent?.toString() ?? null,
      stopLossPercent: stopLossPercent?.toString() ?? null,
      entryPriceEth: entryPriceEth > 0 ? entryPriceEth.toFixed(18) : null,
    })
    .returning();

  // Fire and forget
  runBuy(tradeRow.id, addr, buyAmountEth, slippagePercent).then(() => {
    if ((takeProfitPercent || stopLossPercent) && entryPriceEth > 0) {
      monitorTpSl(
        tradeRow.id,
        addr,
        entryPriceEth,
        takeProfitPercent ?? null,
        stopLossPercent ?? null,
        buyAmountEth,
      ).catch(err => logger.error({ err, tradeId: tradeRow.id }, "TP/SL monitor error"));
    }
  });

  // Return the full Trade object so the client can render it immediately
  res.status(201).json(tradeRow);
});

// ── Simulate (dry-run, zero ETH spent) ─────────────────────────────────────

const SimulateBody = z.object({
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid address"),
  buyAmountEth: z.string().optional().default("0.001"),
});

router.post("/manual/simulate", async (req, res): Promise<void> => {
  const parsed = SimulateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }

  const { tokenAddress, buyAmountEth } = parsed.data;
  const addr = tokenAddress as Address;
  const publicClient = makePublicClient();

  const result: {
    success: boolean;
    tokenName: string | null;
    tokenSymbol: string | null;
    tokenAddress: string;
    buyAmountEth: string;
    expectedTokensOut: string | null;
    minOrderSize: string | null;
    entryPriceEth: string | null;
    errorReason: string | null;
    checks: { tokenReadable: boolean; buySimulatable: boolean };
  } = {
    success: false,
    tokenName: null,
    tokenSymbol: null,
    tokenAddress,
    buyAmountEth,
    expectedTokensOut: null,
    minOrderSize: null,
    entryPriceEth: null,
    errorReason: null,
    checks: { tokenReadable: false, buySimulatable: false },
  };

  // Step 1: Read token name/symbol
  try {
    const [name, symbol] = await Promise.all([
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" }),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
    ]);
    result.tokenName = name as string;
    result.tokenSymbol = symbol as string;
    result.checks.tokenReadable = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errorReason = `Token not readable on-chain — might not be a valid ERC20: ${msg.slice(0, 200)}`;
    res.json(result);
    return;
  }

  // Step 2: Simulate buy() — identical logic as sniper/trader
  try {
    let simAccount: Address;
    try {
      simAccount = privateKeyToAccount(getWalletKey()).address;
    } catch {
      // Fall back to zero address for simulation when no wallet configured
      simAccount = ZERO_ADDRESS;
    }

    const value = parseEther(buyAmountEth);

    const { result: expectedTokens } = await publicClient.simulateContract({
      address: addr,
      abi: ZORA_COIN_BUY_ABI,
      functionName: "buy",
      args: [simAccount, simAccount, ZERO_ADDRESS, "zora-sniper-simulate", 0, 0n, 0n],
      value,
      account: simAccount,
    });

    // 5% default slippage (same as sniper default)
    const defaultSlippageBps = 500n;
    const minOrder = (expectedTokens * (10_000n - defaultSlippageBps)) / 10_000n;

    const tokensNum = parseFloat(formatUnits(expectedTokens, 18));
    const ethNum = parseFloat(buyAmountEth);
    const entryPrice = tokensNum > 0 ? (ethNum / tokensNum).toFixed(18) : "0";

    result.checks.buySimulatable = true;
    result.expectedTokensOut = formatUnits(expectedTokens, 18);
    result.minOrderSize = formatUnits(minOrder, 18);
    result.entryPriceEth = entryPrice;
    result.success = true;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Trim viem verbose stack traces to a useful first line
    const msg = raw.split("\n")[0].slice(0, 300);
    result.errorReason = `Buy simulation failed: ${msg}`;
  }

  req.log.info({ tokenAddress, buyAmountEth, success: result.success }, "Simulate complete");
  res.json(result);
});

// ── Token info ─────────────────────────────────────────────────────────────

router.get("/token/:address", async (req, res): Promise<void> => {
  const address = req.params.address as string | undefined;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    res.status(400).json({ error: "valid 0x token address required" });
    return;
  }

  const addr = address as Address;
  const publicClient = makePublicClient();

  try {
    const [name, symbol, totalSupply] = await Promise.all([
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" }),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "totalSupply" }),
    ]);

    // Wallet balance if available
    let walletBalance = "0";
    try {
      const account = privateKeyToAccount(getWalletKey());
      const rawBal = await publicClient.readContract({
        address: addr,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      walletBalance = formatUnits(rawBal, 18);
    } catch {
      /* no wallet configured */
    }

    // Price estimation via tiny buy simulation
    let priceEth = "0";
    let mcEth = "0";
    try {
      const PROBE_ETH = parseEther("0.0001");
      let probeAccount: Address;
      try {
        probeAccount = privateKeyToAccount(getWalletKey()).address;
      } catch {
        probeAccount = ZERO_ADDRESS;
      }

      const { result: probeTokens } = await publicClient.simulateContract({
        address: addr,
        abi: ZORA_COIN_BUY_ABI,
        functionName: "buy",
        args: [probeAccount, probeAccount, ZERO_ADDRESS, "price-probe", 0, 0n, 0n],
        value: PROBE_ETH,
        account: probeAccount,
      });

      if (probeTokens > 0n) {
        const priceNum = 0.0001 / parseFloat(formatUnits(probeTokens, 18));
        priceEth = priceNum.toFixed(18);
        const mcNum = parseFloat(formatUnits(totalSupply as bigint, 18)) * priceNum;
        mcEth = mcNum.toFixed(6);
      }
    } catch {
      /* pool not yet active or estimation failed */
    }

    res.json({ address: addr, name, symbol, totalSupply: formatUnits(totalSupply as bigint, 18), walletBalance, priceEth, mcEth });
  } catch (err) {
    req.log.error({ err, address }, "Token info fetch failed");
    res.status(500).json({ error: "Failed to fetch token info from chain" });
  }
});

// ── Open positions ─────────────────────────────────────────────────────────

router.get("/positions", async (_req, res): Promise<void> => {
  const openTrades = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.source, "manual"), eq(tradesTable.status, "confirmed")))
    .orderBy(desc(tradesTable.timestamp));

  if (openTrades.length === 0) {
    res.json([]);
    return;
  }

  const publicClient = makePublicClient();
  let walletAddress: Address;
  try {
    walletAddress = privateKeyToAccount(getWalletKey()).address;
  } catch {
    walletAddress = ZERO_ADDRESS;
  }

  const positions = await Promise.all(
    openTrades.map(async (trade) => {
      const addr = trade.tokenAddress as Address;

      // Current on-chain token balance
      let currentBalanceTokens = "0";
      try {
        const rawBal = await publicClient.readContract({
          address: addr,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [walletAddress],
        });
        currentBalanceTokens = formatUnits(rawBal, 18);
      } catch {
        /* keep 0 */
      }

      const entryPriceEth = trade.entryPriceEth ?? "0";
      const entryPriceNum = parseFloat(entryPriceEth);
      const balNum = parseFloat(currentBalanceTokens);

      let currentValueEth = "0";
      let pnlPercent = 0;

      if (balNum > 0 && entryPriceNum > 0) {
        try {
          const PROBE_ETH = parseEther("0.0001");
          const { result: probeTokens } = await publicClient.simulateContract({
            address: addr,
            abi: ZORA_COIN_BUY_ABI,
            functionName: "buy",
            args: [walletAddress, walletAddress, ZERO_ADDRESS, "price-probe", 0, 0n, 0n],
            value: PROBE_ETH,
            account: walletAddress,
          });
          if (probeTokens > 0n) {
            const currentPrice = 0.0001 / parseFloat(formatUnits(probeTokens, 18));
            const currentValue = balNum * currentPrice;
            currentValueEth = currentValue.toFixed(6);
            const buyEth = parseFloat(trade.buyAmountEth);
            pnlPercent = buyEth > 0 ? ((currentValue - buyEth) / buyEth) * 100 : 0;
          }
        } catch {
          /* RPC unavailable — keep defaults */
        }
      }

      return { trade, currentBalanceTokens, entryPriceEth, currentValueEth, pnlPercent };
    }),
  );

  res.json(positions);
});

// ── Manual trades list ─────────────────────────────────────────────────────

router.get("/manual/trades", async (req, res): Promise<void> => {
  const limitParam = req.query.limit;
  const limit = limitParam ? parseInt(String(limitParam), 10) : 20;

  const rows = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.source, "manual"))
    .orderBy(desc(tradesTable.timestamp))
    .limit(Math.min(limit, 100));

  res.json({ trades: rows });
});

// ── Trade status ───────────────────────────────────────────────────────────

router.get("/manual/status/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.id, id), eq(tradesTable.source, "manual")));

  if (!row) { res.status(404).json({ error: "Trade not found" }); return; }
  res.json(row);
});

export default router;
