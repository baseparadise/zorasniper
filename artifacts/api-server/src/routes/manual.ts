import { Router, type IRouter } from "express";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  formatUnits,
  maxUint256,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { db, tradesTable, type Trade } from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { z } from "zod/v4";

const router: IRouter = Router();

// ── Constants ──────────────────────────────────────────────────────────────

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
// Native ETH pseudo-address used by Li.Fi
const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const BASE_CHAIN_ID = 8453;
const LIFI_INTEGRATOR = "zorasniper001"; // Li.Fi integration ID

// ── ABI definitions ────────────────────────────────────────────────────────

const ERC20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

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

// ── Li.Fi integration ──────────────────────────────────────────────────────

interface LiFiQuoteResponse {
  transactionRequest: {
    to: string;
    data: string;
    value: string;
    gasLimit?: string;
    gasPrice?: string;
    from?: string;
  };
  estimate: {
    fromAmount: string;
    toAmount: string;         // expected tokens out (no slippage)
    toAmountMin: string;      // minimum tokens out (with slippage)
    approvalAddress?: string; // spender address for ERC20 approval
    gasCosts?: { amount: string; amountUSD?: string }[];
  };
  action: {
    fromToken: { address: string; decimals: number };
    toToken: { address: string; decimals: number };
    fromAmount: string;
    slippage: number;
  };
  tool?: string; // DEX used, e.g. "uniswap"
  id?: string;
}

/**
 * Get a swap quote from Li.Fi API.
 * fromToken / toToken are token addresses; use ETH_ADDRESS for native ETH.
 */
async function getLiFiQuote(
  fromToken: string,
  toToken: string,
  fromAmountWei: bigint,
  fromAddress: Address,
  slippagePercent: number,
): Promise<LiFiQuoteResponse> {
  const params = new URLSearchParams({
    fromChain: String(BASE_CHAIN_ID),
    toChain: String(BASE_CHAIN_ID),
    fromToken,
    toToken,
    fromAmount: fromAmountWei.toString(),
    fromAddress,
    integrator: LIFI_INTEGRATOR,
    slippage: (slippagePercent / 100).toFixed(4), // Li.Fi expects 0–1 (e.g. 0.05 for 5%)
  });

  const url = `https://li.quest/v1/quote?${params}`;
  logger.info({ url }, "Fetching Li.Fi quote");

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(process.env.LIFI_API_KEY ? { "x-lifi-api-key": process.env.LIFI_API_KEY } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });

  const body = await res.json() as { message?: string; code?: number } & LiFiQuoteResponse;
  if (!res.ok || !body.transactionRequest) {
    const msg = body.message ?? JSON.stringify(body).slice(0, 300);
    throw new Error(`Li.Fi quote failed (${res.status}): ${msg}`);
  }

  return body;
}

/**
 * Ensure the Li.Fi router has enough ERC20 allowance, approving if needed.
 * No-op for native ETH swaps (fromToken = ETH_ADDRESS).
 */
async function ensureApproval(
  publicClient: ReturnType<typeof makePublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: Address,
  tokenAddress: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  if (tokenAddress.toLowerCase() === ETH_ADDRESS.toLowerCase()) return;

  const existing = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account, spender],
  });

  if (existing >= amount) {
    logger.info({ tokenAddress, spender, existing: existing.toString() }, "Allowance already sufficient");
    return;
  }

  logger.info({ tokenAddress, spender, amount: amount.toString() }, "Approving Li.Fi spender");
  const approveTx = await walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, maxUint256],
    account,
    chain: base,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  logger.info({ approveTx }, "Approval confirmed");
}

// ── Background buy executor (Li.Fi) ───────────────────────────────────────

/**
 * Buys the token via Li.Fi swap (ETH → token).
 * Li.Fi automatically routes through the best DEX (Uniswap, bonding curve, etc.)
 * so this works regardless of the Zora market type.
 * Returns the actual ETH-per-token entry price, or 0 on failure.
 */
async function runBuy(
  tradeId: number,
  tokenAddress: Address,
  buyAmountEth: string,
  slippagePercent: number,
): Promise<number> {
  try {
    const account = privateKeyToAccount(getWalletKey());
    const publicClient = makePublicClient();
    const walletClient = createWalletClient({ account, chain: base, transport: http(getHttpRpcUrl()) });

    const fromAmountWei = parseEther(buyAmountEth);

    // Step 1: Get Li.Fi quote (ETH → token)
    const quote = await getLiFiQuote(
      ETH_ADDRESS,
      tokenAddress,
      fromAmountWei,
      account.address,
      slippagePercent,
    );

    const { transactionRequest, estimate, tool } = quote;
    logger.info(
      { tradeId, tool, expectedOut: estimate.toAmount, minOut: estimate.toAmountMin },
      "Li.Fi quote received",
    );

    // Step 2: Execute the swap transaction
    const hash = await walletClient.sendTransaction({
      to: transactionRequest.to as Address,
      data: transactionRequest.data as `0x${string}`,
      value: BigInt(transactionRequest.value || "0"),
      gas: transactionRequest.gasLimit ? BigInt(transactionRequest.gasLimit) : undefined,
      account,
      chain: base,
    });

    logger.info({ tradeId, hash }, "Li.Fi buy tx submitted");

    // Step 3: Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === "success") {
      const gasUsedEth = formatEther(receipt.gasUsed * receipt.effectiveGasPrice);

      // Determine tokens received: check actual on-chain balance delta
      // (more reliable than parsing Li.Fi estimate after the fact)
      let tokenAmount = "0";
      try {
        const rawBal = await publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        });
        // Use the Li.Fi toAmountMin as a sanity floor
        const minOut = BigInt(estimate.toAmountMin);
        if (rawBal >= minOut && rawBal > 0n) {
          // Use the estimate.toAmount (expected) as a proxy since we can't
          // diff without a pre-buy snapshot; worst-case floor is minOut.
          tokenAmount = formatUnits(BigInt(estimate.toAmount), 18);
        } else if (rawBal > 0n) {
          tokenAmount = formatUnits(rawBal, 18);
        } else if (minOut > 0n) {
          tokenAmount = formatUnits(minOut, 18);
        }
      } catch {
        // Fallback to Li.Fi estimate
        if (estimate.toAmountMin && BigInt(estimate.toAmountMin) > 0n) {
          tokenAmount = formatUnits(BigInt(estimate.toAmountMin), 18);
        }
      }

      const tokensNum = parseFloat(tokenAmount);
      const ethNum = parseFloat(buyAmountEth);
      const entryPriceNum = tokensNum > 0 ? ethNum / tokensNum : 0;
      const entryPriceStr = entryPriceNum > 0 ? entryPriceNum.toFixed(18) : null;

      await db
        .update(tradesTable)
        .set({
          status: "confirmed",
          txHash: hash,
          gasUsedEth,
          tokenAmount,
          entryPriceEth: entryPriceStr,
          blockNumber: Number(receipt.blockNumber),
        })
        .where(eq(tradesTable.id, tradeId));

      logger.info({ tradeId, hash, gasUsedEth, tokenAmount, entryPriceNum }, "Manual buy confirmed via Li.Fi");
      return entryPriceNum;
    } else {
      await db
        .update(tradesTable)
        .set({ status: "failed", failReason: "Li.Fi swap tx reverted on-chain" })
        .where(eq(tradesTable.id, tradeId));
      logger.warn({ tradeId, hash }, "Li.Fi buy tx reverted");
      return 0;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(tradesTable)
      .set({ status: "failed", failReason: msg.slice(0, 500) })
      .where(eq(tradesTable.id, tradeId));
    logger.error({ err, tradeId }, "Manual buy execution failed");
    return 0;
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

  let probeAccount: Address;
  try {
    probeAccount = privateKeyToAccount(getWalletKey()).address;
  } catch {
    probeAccount = ZERO_ADDRESS;
  }

  const tpPrice = takeProfitPercent ? entryPriceEth * (1 + takeProfitPercent / 100) : null;
  const slPrice = stopLossPercent ? entryPriceEth * (1 - stopLossPercent / 100) : null;

  logger.info({ tradeId, entryPriceEth, tpPrice, slPrice }, "Starting TP/SL monitor (Li.Fi)");

  const INTERVAL_MS = 15_000;
  const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
  const MAX_SELL_ATTEMPTS = 3;
  const PROBE_AMOUNT_ETH = "0.0001"; // tiny ETH equivalent for price probing
  const startAt = Date.now();
  let sellAttempts = 0;

  while (Date.now() - startAt < MAX_DURATION_MS) {
    await new Promise(r => setTimeout(r, INTERVAL_MS));

    const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, tradeId));
    if (!trade || !["confirmed"].includes(trade.status)) break;

    // Estimate current price via Li.Fi quote for a tiny ETH → token swap
    let currentPrice = entryPriceEth;
    try {
      const probeQuote = await getLiFiQuote(
        ETH_ADDRESS,
        tokenAddress,
        parseEther(PROBE_AMOUNT_ETH),
        probeAccount,
        5, // 5% slippage for price probe
      );
      const probeTokens = parseFloat(formatUnits(BigInt(probeQuote.estimate.toAmount), 18));
      if (probeTokens > 0) {
        currentPrice = parseFloat(PROBE_AMOUNT_ETH) / probeTokens;
      }
    } catch {
      continue; // API issue, retry next interval
    }

    const shouldTp = tpPrice !== null && currentPrice >= tpPrice;
    const shouldSl = slPrice !== null && currentPrice <= slPrice;

    if (!shouldTp && !shouldSl) continue;

    const reason = shouldTp ? "take_profit" : "stop_loss";
    logger.info({ tradeId, reason, currentPrice, tpPrice, slPrice }, "TP/SL triggered, executing sell via Li.Fi");

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
        logger.warn({ tradeId }, "No token balance to sell — position already closed externally");
        break;
      }

      // Get Li.Fi quote for token → ETH sell
      const sellQuote = await getLiFiQuote(
        tokenAddress,
        ETH_ADDRESS,
        rawBal,
        account.address,
        10, // 10% slippage for sell
      );

      // Approve Li.Fi spender if needed
      if (sellQuote.estimate.approvalAddress) {
        await ensureApproval(
          publicClient,
          walletClient,
          account.address,
          tokenAddress,
          sellQuote.estimate.approvalAddress as Address,
          rawBal,
        );
      }

      const { transactionRequest: sellTx } = sellQuote;
      const hash = await walletClient.sendTransaction({
        to: sellTx.to as Address,
        data: sellTx.data as `0x${string}`,
        value: BigInt(sellTx.value || "0"),
        gas: sellTx.gasLimit ? BigInt(sellTx.gasLimit) : undefined,
        account,
        chain: base,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "success") {
        const ethRecovered = sellQuote.estimate.toAmountMin
          ? formatEther(BigInt(sellQuote.estimate.toAmountMin))
          : (parseFloat(formatUnits(rawBal, 18)) * currentPrice).toFixed(6);

        const buyEthNum = parseFloat(buyAmountEth);
        const pnl = (parseFloat(ethRecovered) - buyEthNum).toFixed(6);

        await db
          .update(tradesTable)
          .set({ status: "sold", sellTxHash: hash, sellAmountEth: ethRecovered, pnlEth: pnl })
          .where(eq(tradesTable.id, tradeId));

        logger.info({ tradeId, reason, pnl, ethRecovered, hash }, "TP/SL sell confirmed via Li.Fi");
        break;
      } else {
        throw new Error("Li.Fi sell tx reverted on-chain");
      }
    } catch (err) {
      sellAttempts++;
      logger.error({ err, tradeId, sellAttempts, maxAttempts: MAX_SELL_ATTEMPTS }, "TP/SL sell failed");

      if (sellAttempts >= MAX_SELL_ATTEMPTS) {
        logger.error({ tradeId }, "Max sell attempts reached — monitor exiting");
        break;
      }
      await new Promise(r => setTimeout(r, INTERVAL_MS * 2));
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

  // Estimate entry price via Li.Fi probe quote
  let entryPriceEth = 0;
  try {
    let probeAccount: Address;
    try { probeAccount = privateKeyToAccount(getWalletKey()).address; } catch { probeAccount = ZERO_ADDRESS; }

    const probeQuote = await getLiFiQuote(
      ETH_ADDRESS,
      addr,
      parseEther("0.0001"),
      probeAccount,
      slippagePercent,
    );
    const probeTokens = parseFloat(formatUnits(BigInt(probeQuote.estimate.toAmount), 18));
    if (probeTokens > 0) entryPriceEth = 0.0001 / probeTokens;
  } catch {
    /* price probe failed — entry price stays 0 */
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

  runBuy(tradeRow.id, addr, buyAmountEth, slippagePercent).then((actualEntryPrice) => {
    const monitorEntryPrice = actualEntryPrice > 0 ? actualEntryPrice : entryPriceEth;
    if ((takeProfitPercent || stopLossPercent) && monitorEntryPrice > 0) {
      monitorTpSl(
        tradeRow.id,
        addr,
        monitorEntryPrice,
        takeProfitPercent ?? null,
        stopLossPercent ?? null,
        buyAmountEth,
      ).catch(err => logger.error({ err, tradeId: tradeRow.id }, "TP/SL monitor error"));
    }
  });

  res.status(201).json(tradeRow);
});

// ── Simulate (dry-run via Li.Fi quote) ─────────────────────────────────────

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
    route: string | null;
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
    route: null,
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
    result.errorReason = `Token not readable on-chain: ${msg.slice(0, 200)}`;
    res.json(result);
    return;
  }

  // Step 2: Get Li.Fi quote
  try {
    let simAccount: Address;
    try { simAccount = privateKeyToAccount(getWalletKey()).address; } catch { simAccount = ZERO_ADDRESS; }

    const quote = await getLiFiQuote(
      ETH_ADDRESS,
      addr,
      parseEther(buyAmountEth),
      simAccount,
      5,
    );

    const tokensNum = parseFloat(formatUnits(BigInt(quote.estimate.toAmount), 18));
    const minTokensNum = parseFloat(formatUnits(BigInt(quote.estimate.toAmountMin), 18));
    const ethNum = parseFloat(buyAmountEth);
    const entryPrice = tokensNum > 0 ? (ethNum / tokensNum).toFixed(18) : "0";

    result.checks.buySimulatable = true;
    result.expectedTokensOut = formatUnits(BigInt(quote.estimate.toAmount), 18);
    result.minOrderSize = formatUnits(BigInt(quote.estimate.toAmountMin), 18);
    result.entryPriceEth = entryPrice;
    result.route = quote.tool ?? "unknown";
    result.success = true;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    result.errorReason = `Li.Fi simulation failed: ${raw.split("\n")[0].slice(0, 300)}`;
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

    // Price estimation via Li.Fi quote probe
    let priceEth = "0";
    let mcEth = "0";
    try {
      let probeAccount: Address;
      try { probeAccount = privateKeyToAccount(getWalletKey()).address; } catch { probeAccount = ZERO_ADDRESS; }

      const probeQuote = await getLiFiQuote(
        ETH_ADDRESS,
        addr,
        parseEther("0.0001"),
        probeAccount,
        5,
      );
      const probeTokens = parseFloat(formatUnits(BigInt(probeQuote.estimate.toAmount), 18));
      if (probeTokens > 0) {
        const priceNum = 0.0001 / probeTokens;
        priceEth = priceNum.toFixed(18);
        const mcNum = parseFloat(formatUnits(totalSupply as bigint, 18)) * priceNum;
        mcEth = mcNum.toFixed(6);
      }
    } catch {
      /* pool not yet active or no Li.Fi route */
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
    openTrades.map(async (trade: Trade) => {
      const addr = trade.tokenAddress as Address;

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
          const probeQuote = await getLiFiQuote(
            ETH_ADDRESS,
            addr,
            parseEther("0.0001"),
            walletAddress,
            5,
          );
          const probeTokens = parseFloat(formatUnits(BigInt(probeQuote.estimate.toAmount), 18));
          if (probeTokens > 0) {
            const currentPrice = 0.0001 / probeTokens;
            const currentValue = balNum * currentPrice;
            currentValueEth = currentValue.toFixed(6);
            const buyEth = parseFloat(trade.buyAmountEth);
            pnlPercent = buyEth > 0 ? ((currentValue - buyEth) / buyEth) * 100 : 0;
          }
        } catch {
          /* Li.Fi unavailable — keep defaults */
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


// ── Startup recovery: restart TP/SL monitors for confirmed trades ──────────

/**
 * Called once at server startup. Finds all confirmed manual trades that
 * still have TP or SL set and restarts their in-memory monitors.
 * Without this, monitors die on every Railway redeploy/restart.
 */
export async function recoverTpSlMonitors(): Promise<void> {
  try {
    const openTrades = await db
      .select()
      .from(tradesTable)
      .where(
        and(
          eq(tradesTable.source, 'manual'),
          eq(tradesTable.status, 'confirmed'),
        ),
      );

    const recoverable = openTrades.filter(
      (t) => (t.takeProfitPercent || t.stopLossPercent) && t.entryPriceEth,
    );

    if (recoverable.length === 0) {
      logger.info('TP/SL recovery: no active monitors to restart');
      return;
    }

    logger.info({ count: recoverable.length }, 'TP/SL recovery: restarting monitors');

    for (const trade of recoverable) {
      const entryPrice = parseFloat(trade.entryPriceEth!);
      const tp = trade.takeProfitPercent ? parseFloat(trade.takeProfitPercent) : null;
      const sl = trade.stopLossPercent ? parseFloat(trade.stopLossPercent) : null;

      monitorTpSl(
        trade.id,
        trade.tokenAddress as Address,
        entryPrice,
        tp,
        sl,
        trade.buyAmountEth ?? '0',
      ).catch((err) =>
        logger.error({ err, tradeId: trade.id }, 'TP/SL recovery monitor error'),
      );

      logger.info({ tradeId: trade.id, token: trade.tokenAddress, tp, sl }, 'TP/SL monitor recovered');
    }
  } catch (err) {
    logger.error({ err }, 'TP/SL recovery failed — monitors not restarted');
  }
}

export default router;
