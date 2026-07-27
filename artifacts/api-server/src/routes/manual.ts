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

      // Get current token balance to infer amount received
      const rawBalance = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      const tokenAmount = formatUnits(rawBalance, 18);
      const entryPriceEth =
        rawBalance > 0n
          ? (parseFloat(buyAmountEth) / parseFloat(tokenAmount)).toFixed(18)
          : "0";

      await db
        .update(tradesTable)
        .set({
          status: "confirmed",
          txHash: hash,
          tokenAmount,
          gasUsedEth,
          entryPriceEth,
          blockNumber: Number(receipt.blockNumber),
        })
        .where(eq(tradesTable.id, tradeId));

      logger.info({ tradeId, hash, tokenAmount }, "Manual buy confirmed");
    } else {
      await db
        .update(tradesTable)
        .set({ status: "failed", failReason: "Transaction reverted on-chain" })
        .where(eq(tradesTable.id, tradeId));
      logger.warn({ tradeId, hash }, "Manual buy reverted");
    }
  } catch (err) {
    const failReason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await db
      .update(tradesTable)
      .set({ status: "failed", failReason })
      .where(eq(tradesTable.id, tradeId));
    logger.error({ err, tradeId }, "Manual buy failed");
  }
}

// ── Validation schemas ─────────────────────────────────────────────────────

const ManualBuyBodySchema = z.object({
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid EVM address"),
  buyAmountEth: z.string().regex(/^\d*\.?\d+$/, "Must be a valid number"),
  slippagePercent: z.number().min(0).max(100),
  takeProfitPercent: z.number().nullable().optional(),
  stopLossPercent: z.number().nullable().optional(),
});

// ── Routes ────────────────────────────────────────────────────────────────

// POST /trades/manual-buy
router.post("/trades/manual-buy", async (req, res): Promise<void> => {
  const parsed = ManualBuyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { tokenAddress, buyAmountEth, slippagePercent, takeProfitPercent, stopLossPercent } =
    parsed.data;

  const addr = tokenAddress as Address;

  // Fetch token metadata from chain
  let tokenName = "Unknown";
  let tokenSymbol = "???";
  try {
    const publicClient = makePublicClient();
    [tokenName, tokenSymbol] = await Promise.all([
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" }),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
    ]);
  } catch (err) {
    req.log.warn({ err, tokenAddress }, "Failed to fetch token metadata, using fallback");
  }

  // Create pending trade record
  const [trade] = await db
    .insert(tradesTable)
    .values({
      tokenAddress: addr.toLowerCase(),
      tokenName,
      tokenSymbol,
      creatorAddress: "manual",
      buyAmountEth,
      status: "pending",
      source: "manual",
      takeProfitPercent: takeProfitPercent != null ? String(takeProfitPercent) : null,
      stopLossPercent: stopLossPercent != null ? String(stopLossPercent) : null,
    })
    .returning();

  // Fire-and-forget background execution
  runBuy(trade.id, addr, buyAmountEth, slippagePercent).catch((err) =>
    logger.error({ err, tradeId: trade.id }, "runBuy unexpected error"),
  );

  res.status(201).json(trade);
});

// GET /positions — open manual positions (pending + confirmed, not sold/failed)
router.get("/positions", async (_req, res): Promise<void> => {
  const openTrades = await db
    .select()
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.source, "manual"),
        inArray(tradesTable.status, ["pending", "confirmed"]),
      ),
    )
    .orderBy(desc(tradesTable.timestamp));

  if (openTrades.length === 0) {
    res.json([]);
    return;
  }

  // Fetch current on-chain balances for each unique token
  const publicClient = makePublicClient();
  let walletAddress: Address | null = null;
  try {
    const account = privateKeyToAccount(getWalletKey());
    walletAddress = account.address;
  } catch {
    // No wallet configured — return positions without live balance
    res.json(
      openTrades.map((t) => ({
        trade: t,
        currentBalanceTokens: "0",
        entryPriceEth: t.entryPriceEth ?? "0",
        currentValueEth: "0",
        pnlPercent: 0,
      })),
    );
    return;
  }

  const positions = await Promise.all(
    openTrades.map(async (trade) => {
      let currentBalanceTokens = "0";
      let currentValueEth = "0";
      let pnlPercent = 0;

      const entryPriceEth = trade.entryPriceEth ?? "0";

      try {
        const rawBalance = await publicClient.readContract({
          address: trade.tokenAddress as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [walletAddress!],
        });
        currentBalanceTokens = formatUnits(rawBalance, 18);

        // Estimate current value using entry price (conservative but always available)
        const balanceNum = parseFloat(currentBalanceTokens);
        const entryNum = parseFloat(entryPriceEth);
        if (balanceNum > 0 && entryNum > 0) {
          currentValueEth = (balanceNum * entryNum).toFixed(6);
        }

        // Try to get a live price via tiny simulation
        try {
          const PROBE_ETH = parseEther("0.0001");
          const { result: probeTokens } = await publicClient.simulateContract({
            address: trade.tokenAddress as Address,
            abi: ZORA_COIN_BUY_ABI,
            functionName: "buy",
            args: [walletAddress!, walletAddress!, ZERO_ADDRESS, "price-probe", 0, 0n, 0n],
            value: PROBE_ETH,
            account: walletAddress!,
          });
          if (probeTokens > 0n) {
            const currentPriceEth = 0.0001 / parseFloat(formatUnits(probeTokens, 18));
            currentValueEth = (balanceNum * currentPriceEth).toFixed(6);
            const buyAmountNum = parseFloat(trade.buyAmountEth);
            pnlPercent =
              buyAmountNum > 0
                ? ((parseFloat(currentValueEth) - buyAmountNum) / buyAmountNum) * 100
                : 0;
          }
        } catch {
          // Price probe failed — P&L stays 0
        }
      } catch (err) {
        logger.warn({ err, tokenAddress: trade.tokenAddress }, "Failed to fetch position balance");
      }

      return {
        trade,
        currentBalanceTokens,
        entryPriceEth,
        currentValueEth,
        pnlPercent: Math.round(pnlPercent * 100) / 100,
      };
    }),
  );

  res.json(positions);
});

// GET /token/:address — on-chain token info
router.get("/token/:address", async (req, res): Promise<void> => {
  const { address } = req.params;

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    res.status(400).json({ error: "Invalid EVM address" });
    return;
  }

  const addr = address as Address;
  const publicClient = makePublicClient();

  try {
    const [name, symbol, totalSupplyRaw] = await Promise.all([
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "name" }),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
      publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: "totalSupply" }),
    ]);

    const totalSupply = formatUnits(totalSupplyRaw, 18);

    // Wallet balance
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
        const mcNum = parseFloat(totalSupply) * priceNum;
        mcEth = mcNum.toFixed(6);
      }
    } catch {
      /* pool not yet active or estimation failed */
    }

    res.json({ address: addr, name, symbol, totalSupply, walletBalance, priceEth, mcEth });
  } catch (err) {
    req.log.error({ err, address }, "Token info fetch failed");
    res.status(500).json({ error: "Failed to fetch token info from chain" });
  }
});

export default router;
