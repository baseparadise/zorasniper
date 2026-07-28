import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  formatEther,
  formatUnits,
  maxUint256,
  encodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { db, tradesTable, creatorsTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { botState } from "./state";
import { broadcast } from "./ws";
import { loadConfig } from "../lib/config";

// ── ERC20 ABI — balanceOf + allowance + approve ───────────────────────────
const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// Zora Quote API endpoint
const ZORA_QUOTE_API = "https://api-sdk.zora.engineering";

// Permit2 universal contract address (same on all EVM chains)
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

// ── Zora API key rotator ─────────────────────────────────────────────────────
// Supports multiple keys via ZORA_API_KEYS (comma-separated).
// Falls back to ZORA_API_KEY for backward compatibility.
// Uses round-robin so concurrent calls spread load across keys.
const ZORA_API_KEYS: string[] = (() => {
  const multi = process.env.ZORA_API_KEYS;
  if (multi) return multi.split(',').map((k) => k.trim()).filter(Boolean);
  const single = process.env.ZORA_API_KEY;
  return single ? [single] : [];
})();
let _zoraKeyIdx = 0;
function nextZoraKey(): string | undefined {
  if (ZORA_API_KEYS.length === 0) return undefined;
  const key = ZORA_API_KEYS[_zoraKeyIdx % ZORA_API_KEYS.length];
  _zoraKeyIdx = (_zoraKeyIdx + 1) % ZORA_API_KEYS.length;
  return key;
}

// Small probe amount for price estimation (never actually sent)
const PROBE_ETH_WEI = parseEther("0.001");

export interface TradeParams {
  tokenAddress: Address;
  tokenName: string;
  tokenSymbol: string;
  creatorAddress: string;
  buyAmountEth: string;
  slippagePercent: number;
  maxGasGwei: number;
  /** The factory event that triggered this snipe (kept for logging). */
  eventName: string;
  /**
   * TP/SL from global config captured at buy time.
   * Stored in the trade row and handed to the Zora-based sniper monitor.
   */
  takeProfitPercent?: number | null;
  stopLossPercent?: number | null;
}

interface ZoraCall {
  target: string;
  data: string;
  value: string;
}

interface ZoraPermit {
  permit: {
    details: {
      token: string;
      amount: string;
      expiration: number;
      nonce: number;
    };
    spender: string;
    sigDeadline: string;
  };
  /** Placeholder string returned by Zora API — must be replaced with actual EIP-712 sig. */
  signature: string;
}

interface ZoraQuoteResult {
  call: ZoraCall;
  permits: ZoraPermit[];
}

/**
 * Injects a signed Permit2 signature into Zora API calldata.
 *
 * The Zora API returns sell calldata with a literal ASCII placeholder
 * "REPLACE_WITH_PERMIT_SIGNATURE_1" where the 65-byte EIP-712 signature
 * must be inserted.  The bytes field is ABI-encoded as:
 *   - 32 bytes = length prefix (0x41 = 65)
 *   - 65 bytes = signature
 *   - 31 bytes = zero-padding to next 32-byte boundary
 * Total span in the hex string: 256 chars (128 bytes).
 */
function injectPermitSignature(callDataHex: string, signature: `0x${string}`): string {
  const PLACEHOLDER = "REPLACE_WITH_PERMIT_SIGNATURE_1";
  const idx = callDataHex.indexOf(PLACEHOLDER);
  if (idx === -1) {
    throw new Error("injectPermitSignature: placeholder not found in calldata — API response format may have changed");
  }
  const sigHex = signature.slice(2); // 130 hex chars (65 bytes)
  if (sigHex.length !== 130) {
    throw new Error(`injectPermitSignature: unexpected signature length ${sigHex.length} (expected 130 hex chars)`);
  }
  // ABI-encoded bytes for 65-byte sig: 32-byte length + 65-byte data + 31-byte pad = 128 bytes = 256 hex chars
  const lengthPrefix = "0000000000000000000000000000000000000000000000000000000000000041"; // 64 chars
  const zeroPad = "0".repeat(62); // 31 bytes padding → 62 chars
  const encodedSig = lengthPrefix + sigHex + zeroPad; // 256 chars total
  // Replace the full 256-char slot starting at the placeholder position
  return callDataHex.slice(0, idx) + encodedSig + callDataHex.slice(idx + PLACEHOLDER.length);
}

/**
 * Ensure a hex string is valid and has the 0x prefix.
 * Zora API sometimes omits the prefix, and may include whitespace/newlines
 * in the JSON response. Throws immediately if the result is not valid hex —
 * better to fail fast than to send malformed calldata and get
 * "Invalid byte sequence" from the Base RPC.
 */
function toHex(s: string): `0x${string}` {
  if (!s) return "0x";
  // Strip whitespace / newlines that can appear in Zora API JSON responses
  const stripped = s.trim().replace(/[\s\r\n]/g, "");
  const clean = stripped.startsWith("0x") ? stripped : `0x${stripped}`;
  if (!/^0x[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(
      `toHex: invalid hex from Zora API (first 80 chars): ${clean.slice(0, 80)}`,
    );
  }
  return clean as `0x${string}`;
}

/** Safely parse a bigint from a string that may be null/undefined/empty. */
function toBigIntSafe(s: string | null | undefined, fallback = 0n): bigint {
  if (!s || s === "") return fallback;
  try { return BigInt(s); } catch { return fallback; }
}

function getRpcUrl(): string {
  const url = process.env.ALCHEMY_RPC_URL;
  if (!url) throw new Error("ALCHEMY_RPC_URL is not set");
  return url;
}

/**
 * ALCHEMY_RPC_URL is typically wss:// (needed by sniper.ts for WebSocket).
 * HTTP clients must use https:// — convert the scheme.
 */
function getHttpRpcUrl(): string {
  return getRpcUrl()
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://");
}

function getWalletKey(): `0x${string}` {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) throw new Error("WALLET_PRIVATE_KEY is not set");
  return key.startsWith("0x") ? (key as `0x${string}`) : `0x${key}`;
}

// ── Zora Quote API helpers ────────────────────────────────────────────────

/**
 * Fetch a BUY quote from Zora Quote API (ETH → erc20).
 * Retries up to 3 times with a 5-second delay — Zora pools need a few blocks
 * after deployment before they are ready to quote.
 */
async function fetchZoraQuote(params: {
  tokenAddress: string;
  buyAmountWei: bigint;
  slippage: number; // fractional, e.g. 0.05 for 5%
  sender: string;
}): Promise<ZoraCall> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const _apiKey = nextZoraKey();
  if (_apiKey) headers["x-api-key"] = _apiKey;

  const body = JSON.stringify({
    chainId: base.id,
    tokenIn: { type: "eth" },
    tokenOut: { type: "erc20", address: params.tokenAddress.toLowerCase() },
    amountIn: params.buyAmountWei.toString(),
    slippage: params.slippage,
    sender: params.sender.toLowerCase(),
    recipient: params.sender.toLowerCase(),
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${ZORA_QUOTE_API}/quote`, {
      method: "POST",
      headers,
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const isPoolNotReady =
        text.includes("Cannot read properties of null") ||
        text.includes("UNKNOWN") ||
        res.status === 400;

      if (isPoolNotReady && attempt < 3) {
        logger.warn(
          { attempt, status: res.status, body: text.slice(0, 100) },
          `Zora quote attempt ${attempt}/3 — pool not ready yet, retry in 5s`,
        );
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      throw new Error(`Zora quote HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!data.call) {
      if (attempt < 3) {
        logger.warn({ attempt, data }, `Zora quote attempt ${attempt}/3 — no call field, retry in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw new Error(`Zora quote returned no call: ${JSON.stringify(data).slice(0, 200)}`);
    }

    logger.info({ attempt, target: data.call.target }, "Zora buy quote OK");
    return data.call as ZoraCall;
  }

  throw new Error("Zora quote failed after 3 attempts — pool not ready or token invalid");
}

/** USDC address on Base — primary sell currency (more reliable routing than ETH for Zora content coins). */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const USDC_DECIMALS = 6;

    // ── Uniswap V4 Universal Router ───────────────────────────────────────────

    /** Universal Router V4 on Base — sell directly without Zora API. */
    const UNIVERSAL_ROUTER_V4 = "0x6fF5693b99212Da76ad316178a184AB56D299b43" as Address;

    /** Zora factory — looked up to retrieve CoinCreatedV4 poolKey at sell time. */
    const ZORA_FACTORY_ADDR = "0x777777751622c0d3258f214F9DF38E35BF45baF3" as Address;

    // Inner V4 Router action bytes (Uniswap V4 periphery Actions.sol)
    const V4_ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
    const V4_ACTION_SETTLE_ALL = 0x0c;
    const V4_ACTION_TAKE_ALL = 0x0f;

    const COIN_CREATED_V4_SCHEMA = {
    type: "event",
    name: "CoinCreatedV4",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "payoutRecipient", type: "address", indexed: true },
      { name: "platformReferrer", type: "address", indexed: true },
      { name: "currency", type: "address", indexed: false },
      { name: "uri", type: "string", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "coin", type: "address", indexed: false },
      {
        name: "poolKey",
        type: "tuple",
        indexed: false,
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "poolKeyHash", type: "bytes32", indexed: false },
      { name: "version", type: "string", indexed: false },
    ],
    } as const;

    const UNIVERSAL_ROUTER_EXECUTE_ABI = [
    {
      type: "function",
      name: "execute",
      stateMutability: "payable",
      inputs: [
        { name: "commands", type: "bytes" },
        { name: "inputs", type: "bytes[]" },
        { name: "deadline", type: "uint256" },
      ],
      outputs: [],
    },
    ] as const;

    interface V4PoolKey {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
    }

    /**
    * Look up the Uniswap V4 pool key for a Zora coin from factory event logs.
    * When mintBlockNumber is known the scan covers only ~40 blocks; otherwise
    * it chunks through the last 50 000 blocks (≈1.2 days on Base).
    */
    async function fetchV4PoolKey(
    tokenAddress: Address,
    mintBlockNumber: bigint | null,
    publicClient: ReturnType<typeof createPublicClient>,
    ): Promise<V4PoolKey | null> {
    const latestBlock = await publicClient.getBlockNumber();
    let fromBlock: bigint;
    let toBlock: bigint;

    if (mintBlockNumber && mintBlockNumber > 0n) {
      fromBlock = mintBlockNumber > 20n ? mintBlockNumber - 20n : 0n;
      toBlock = mintBlockNumber + 20n;
    } else {
      fromBlock = latestBlock > 50_000n ? latestBlock - 50_000n : 0n;
      toBlock = latestBlock;
    }

    const CHUNK = 2_000n; // Alchemy cap for un-indexed topic queries
    for (let start = fromBlock; start <= toBlock; start += CHUNK) {
      const end = start + CHUNK - 1n < toBlock ? start + CHUNK - 1n : toBlock;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const logs = await publicClient.getLogs({
        address: ZORA_FACTORY_ADDR,
        event: COIN_CREATED_V4_SCHEMA as any,
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const args = (log as any).args as { coin?: string; poolKey?: V4PoolKey };
        if (args.coin?.toLowerCase() === tokenAddress.toLowerCase() && args.poolKey) {
          return args.poolKey as V4PoolKey;
        }
      }
    }
    return null;
    }

    /**
    * Sell token via Uniswap V4 Universal Router — no Zora API, no Permit2.
    *
    * Steps:
    *  1. Fetch CoinCreatedV4 poolKey from Zora factory logs
    *  2. Standard ERC-20 approve to Universal Router
    *  3. Encode V4_SWAP + SETTLE_ALL + TAKE_ALL → execute()
    *  4. Record amount received in DB
    */
    export async function executeUniversalRouterSell(params: {
    tradeId: number;
    tokenAddress: Address;
    tokenBalance: bigint;
    slippagePercent: number;
    maxGasGwei: number;
    reason: string;
    }): Promise<void> {
    const { tradeId, tokenAddress, tokenBalance, maxGasGwei, reason } = params;
    const account = privateKeyToAccount(getWalletKey());
    const httpUrl = getHttpRpcUrl();
    const publicClient = createPublicClient({ chain: base, transport: http(httpUrl) });
    const walletClient = createWalletClient({ account, chain: base, transport: http(httpUrl) });

    const logCtx = { tradeId, reason, method: "uniswap_v4_router" };
    logger.info(logCtx, "executeUniversalRouterSell: starting");

    // Get blockNumber from DB to narrow pool-key search window
    const [tradeRec] = await db
      .select({ blockNumber: tradesTable.blockNumber })
      .from(tradesTable)
      .where(eq(tradesTable.id, tradeId));
    const mintBlock = tradeRec?.blockNumber ? BigInt(tradeRec.blockNumber) : null;

    // ── Resolve poolKey ───────────────────────────────────────────────────────
    const poolKey = await fetchV4PoolKey(tokenAddress, mintBlock, publicClient);
    if (!poolKey) {
      throw new Error(
        `executeUniversalRouterSell: no CoinCreatedV4 poolKey found for ${tokenAddress}`,
      );
    }
    logger.info({ ...logCtx, poolKey }, "V4 poolKey resolved");

    // ── Swap direction ────────────────────────────────────────────────────────
    const zeroForOne = poolKey.currency0.toLowerCase() === tokenAddress.toLowerCase();
    const outCurrency: Address = zeroForOne ? poolKey.currency1 : poolKey.currency0;
    const isNativeOut = BigInt(outCurrency) === 0n;

    // Snapshot balances before sell
    const ethBefore = isNativeOut ? await publicClient.getBalance({ address: account.address }) : 0n;
    const erc20Before = !isNativeOut
      ? await publicClient.readContract({
          address: outCurrency,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        })
      : 0n;

    // ── Approve Universal Router (plain ERC-20, no Permit2) ───────────────────
    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, UNIVERSAL_ROUTER_V4],
    });
    if (allowance < tokenBalance) {
      logger.info({ ...logCtx, spender: UNIVERSAL_ROUTER_V4 }, "Approving Universal Router V4");
      const approveTx = await walletClient.writeContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [UNIVERSAL_ROUTER_V4, maxUint256],
        chain: base,
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
      logger.info({ ...logCtx, approveTx }, "Approval confirmed");
    }

    // ── Encode V4 swap ────────────────────────────────────────────────────────
    const actions = encodePacked(
      ["uint8", "uint8", "uint8"],
      [V4_ACTION_SWAP_EXACT_IN_SINGLE, V4_ACTION_SETTLE_ALL, V4_ACTION_TAKE_ALL],
    );

    const amountOutMinimum = 0n;

    const swapParams = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            {
              type: "tuple",
              name: "poolKey",
              components: [
                { type: "address", name: "currency0" },
                { type: "address", name: "currency1" },
                { type: "uint24", name: "fee" },
                { type: "int24", name: "tickSpacing" },
                { type: "address", name: "hooks" },
              ],
            },
            { type: "bool", name: "zeroForOne" },
            { type: "uint128", name: "amountIn" },
            { type: "uint128", name: "amountOutMinimum" },
            { type: "uint256", name: "minHopPriceX36" },
            { type: "bytes", name: "hookData" },
          ],
        },
      ],
      [{ poolKey, zeroForOne, amountIn: tokenBalance, amountOutMinimum, minHopPriceX36: 0n, hookData: "0x" }],
    );

    const settleParams = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [tokenAddress, tokenBalance],
    );

    const takeParams = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [outCurrency, amountOutMinimum],
    );

    const v4SwapInput = encodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes[]" }],
      [actions, [swapParams, settleParams, takeParams]],
    );

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const callData = encodeFunctionData({
      abi: UNIVERSAL_ROUTER_EXECUTE_ABI,
      functionName: "execute",
      args: ["0x10" as `0x${string}`, [v4SwapInput], deadline],
    });

    // ── Gas estimation → send tx ──────────────────────────────────────────────
    const maxFeeCapWei = BigInt(Math.round(maxGasGwei * 1e9));
    let feeEstimate: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    let estimatedGas: bigint;
    try {
      const [fees, gas] = await Promise.all([
        publicClient.estimateFeesPerGas(),
        publicClient.estimateGas({ to: UNIVERSAL_ROUTER_V4, data: callData, account: account.address }),
      ]);
      feeEstimate = fees;
      estimatedGas = gas;
    } catch (gasErr) {
      logger.warn({ ...logCtx, err: gasErr }, "Gas estimation failed — using 600k fallback");
      feeEstimate = await publicClient.estimateFeesPerGas();
      estimatedGas = 600_000n;
    }

    const maxFeePerGas =
      feeEstimate.maxFeePerGas < maxFeeCapWei ? feeEstimate.maxFeePerGas : maxFeeCapWei;
    const maxPriorityFeePerGas =
      feeEstimate.maxPriorityFeePerGas < maxFeePerGas
        ? feeEstimate.maxPriorityFeePerGas
        : maxFeePerGas;
    const gasLimit = (estimatedGas * 120n) / 100n; // 20% buffer for V4 hook calls

    logger.info(
      { ...logCtx, gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString() },
      "Sending Universal Router V4 sell tx",
    );

    const sellTxHash = await walletClient.sendTransaction({
      to: UNIVERSAL_ROUTER_V4,
      data: callData,
      chain: base,
      account,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gas: gasLimit,
    });

    logger.info({ ...logCtx, sellTxHash }, "Tx submitted — waiting for receipt");
    await publicClient.waitForTransactionReceipt({ hash: sellTxHash, timeout: 120_000 });
    logger.info({ ...logCtx, sellTxHash }, "Universal Router V4 sell confirmed");

    // ── Calculate received amount ─────────────────────────────────────────────
    let sellAmountEth: string;
    if (isNativeOut) {
      const ethAfter = await publicClient.getBalance({ address: account.address });
      const received = ethAfter > ethBefore ? ethAfter - ethBefore : 0n;
      sellAmountEth = formatEther(received);
    } else {
      const erc20After = await publicClient.readContract({
        address: outCurrency,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      const received = erc20After > erc20Before ? erc20After - erc20Before : 0n;
      const isUsdc = outCurrency.toLowerCase() === USDC_BASE.toLowerCase();
      sellAmountEth = isUsdc ? formatUnits(received, USDC_DECIMALS) : formatEther(received);
    }

    const [updated] = await db
      .update(tradesTable)
      .set({ status: "sold", sellTxHash, sellAmountEth, pnlEth: sellAmountEth })
      .where(eq(tradesTable.id, tradeId))
      .returning();

    broadcast("trade", updated);
    logger.info({ ...logCtx, sellAmountEth }, "Sell confirmed via Uniswap V4 Universal Router");
    }

/**
 * Generic Zora Quote API caller.
 * tokenIn / tokenOut each follow the Zora API shape:
 *   { type: "eth" } or { type: "erc20", address: "0x..." }
 */
async function fetchZoraQuoteGeneric(params: {
  tokenIn: { type: "eth" } | { type: "erc20"; address: string };
  tokenOut: { type: "eth" } | { type: "erc20"; address: string };
  amountIn: bigint;
  slippage: number; // fractional, e.g. 0.05
  sender: string;
  label?: string; // log label
}): Promise<ZoraQuoteResult> {
  const { tokenIn, tokenOut, amountIn, slippage, sender, label = "Zora quote" } = params;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const _apiKey = nextZoraKey();
  if (_apiKey) headers["x-api-key"] = _apiKey;

  const body = JSON.stringify({
    chainId: base.id,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    slippage,
    sender: sender.toLowerCase(),
    recipient: sender.toLowerCase(),
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${ZORA_QUOTE_API}/quote`, { method: "POST", headers, body });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Detect "SwapError: Failed to get quote" — no point retrying, surface immediately
      const isNoRoute =
        text.includes("SwapError") ||
        text.includes("Failed to get quote") ||
        (res.status === 400 && text.includes("UNKNOWN"));
      if (isNoRoute) {
        throw new Error(`ZoraNoRoute: ${text.slice(0, 200)}`);
      }
      if (attempt < 3) {
        logger.warn({ attempt, status: res.status, body: text.slice(0, 100) }, `${label} attempt ${attempt}/3 failed, retry in 5s`);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!data.call) {
      // Fix: API returns success as a boolean, not the string "false"
      if (data.success === false || data.error) {
        // API returned 200 but with an error payload — treat as no-route
        throw new Error(`ZoraNoRoute: ${JSON.stringify(data).slice(0, 200)}`);
      }
      if (attempt < 3) {
        logger.warn({ attempt, data }, `${label} attempt ${attempt}/3 — no call, retry in 5s`);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      throw new Error(`${label} returned no call: ${JSON.stringify(data).slice(0, 200)}`);
    }

    const permits: ZoraPermit[] = Array.isArray(data.permits) ? data.permits : [];
    logger.info({ attempt, target: data.call.target, permitsCount: permits.length }, `${label} OK`);
    return { call: data.call as ZoraCall, permits };
  }

  throw new Error(`${label} failed after 3 attempts`);
}

/**
 * Fetch a SELL quote from Zora Quote API (erc20 → USDC).
 * USDC routing is more reliable than ETH for Zora content coins whose pools
 * pair against a creator coin rather than WETH directly.
 * Throws ZoraNoRoute error (message starts with "ZoraNoRoute:") if the Zora API
 * cannot find a route — the caller can then attempt a two-step sell.
 *
 * Returns both the calldata and the permits array. When permits are non-empty,
 * the calldata contains the placeholder "REPLACE_WITH_PERMIT_SIGNATURE_1" that
 * must be replaced with the signed Permit2 EIP-712 signature before submission.
 */
async function fetchZoraSellQuote(params: {
  tokenAddress: string;
  tokenAmountWei: bigint;
  slippage: number; // fractional
  sender: string;
}): Promise<ZoraQuoteResult> {
  return fetchZoraQuoteGeneric({
    tokenIn: { type: "erc20", address: params.tokenAddress.toLowerCase() },
    tokenOut: { type: "erc20", address: USDC_BASE.toLowerCase() },
    amountIn: params.tokenAmountWei,
    slippage: params.slippage,
    sender: params.sender,
    label: "Zora sell quote (→USDC)",
  });
}

/**
 * Execute a single Zora swap transaction: approve spender → simulate (warn-only)
 * → estimate gas → send tx → wait for receipt.
 * Returns the tx hash on success, throws on failure.
 */
async function executeZoraSwapTx(params: {
  call: ZoraCall;
  tokenInAddress: Address | null; // null for native ETH swaps (no approval needed)
  tokenInAmount: bigint;
  maxGasGwei: number;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  logCtx: Record<string, unknown>;
}): Promise<`0x${string}`> {
  const { call, tokenInAddress, tokenInAmount, maxGasGwei, publicClient, walletClient, account, logCtx } = params;
  const routerAddress = toHex(call.target) as Address;

  // Approve if selling an ERC20
  if (tokenInAddress) {
    const allowance = await publicClient.readContract({
      address: tokenInAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, routerAddress],
    });
    if (allowance < tokenInAmount) {
      logger.info({ ...logCtx, spender: call.target }, "Approving Zora router");
      const approveTx = await walletClient.writeContract({
        address: tokenInAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [routerAddress, maxUint256],
        chain: base,
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
      logger.info({ ...logCtx, approveTx }, "Approval confirmed");
    }
  }

  // Simulate (warning-only — Zora router often reverts in eth_call)
  try {
    await publicClient.call({
      to: routerAddress,
      data: toHex(call.data),
      value: toBigIntSafe(call.value),
      account: account.address,
    });
    logger.info(logCtx, "Swap simulation passed");
  } catch (simErr) {
    const msg = simErr instanceof Error ? simErr.message.slice(0, 200) : String(simErr);
    logger.warn({ ...logCtx, msg }, "Swap simulation warning — proceeding");
  }

  // Gas estimation with fallback
  const maxFeeCapWei = BigInt(Math.round(maxGasGwei * 1e9));
  let feeEstimate: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  let estimatedGas: bigint;
  try {
    const [fees, gas] = await Promise.all([
      publicClient.estimateFeesPerGas(),
      publicClient.estimateGas({
        to: routerAddress,
        data: toHex(call.data),
        value: toBigIntSafe(call.value),
        account: account.address,
      }),
    ]);
    feeEstimate = fees;
    estimatedGas = gas;
  } catch (gasErr) {
    logger.warn({ ...logCtx, err: gasErr }, "Gas estimation failed — using 500k fallback");
    feeEstimate = await publicClient.estimateFeesPerGas();
    estimatedGas = 500_000n;
  }
  const maxFeePerGas =
    feeEstimate.maxFeePerGas < maxFeeCapWei ? feeEstimate.maxFeePerGas : maxFeeCapWei;
  const maxPriorityFeePerGas =
    feeEstimate.maxPriorityFeePerGas < maxFeePerGas
      ? feeEstimate.maxPriorityFeePerGas
      : maxFeePerGas;
  const gasLimit = (estimatedGas * 120n) / 100n;

  const txHash = await walletClient.sendTransaction({
    to: routerAddress,
    data: toHex(call.data),
    value: toBigIntSafe(call.value),
    chain: base,
    account,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  logger.info({ ...logCtx, txHash }, "Swap tx submitted");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });

  if (receipt.status !== "success") {
    throw new Error(`Swap tx reverted on-chain: ${txHash}`);
  }

  logger.info({ ...logCtx, txHash }, "Swap tx confirmed");
  return txHash;
}

/**
 * Probe current token price (ETH per token) via the Zora Quote API.
 * Returns null if the price cannot be determined (new pool, API issue, etc.).
 *
 * Strategy:
 * 1. Tiny buy quote (PROBE_ETH_WEI → token) — parse amountOut from response
 *    if the API returns it (field names vary by API version).
 * 2. Fallback: GET /coin endpoint for indexed price data.
 *
 * NOTE: For very new tokens (< few blocks old), both probes may return null.
 * The monitor loop simply skips the cycle and retries — this is expected
 * behaviour and will self-resolve as the pool gets indexed.
 */
async function fetchZoraPriceProbe(
  tokenAddress: string,
  sender: string,
): Promise<number | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const _apiKey = nextZoraKey();
  if (_apiKey) headers["x-api-key"] = _apiKey;

  // ── Strategy 1: buy-direction probe ──────────────────────────────────────
  try {
    const body = JSON.stringify({
      chainId: base.id,
      tokenIn: { type: "eth" },
      tokenOut: { type: "erc20", address: tokenAddress.toLowerCase() },
      amountIn: PROBE_ETH_WEI.toString(),
      slippage: 0.5, // generous — probe only, not executed
      sender: sender.toLowerCase(),
      recipient: sender.toLowerCase(),
    });

    const res = await fetch(`${ZORA_QUOTE_API}/quote`, { method: "POST", headers, body });

    if (res.ok) {
      const data = await res.json();
      // Zora API returns amountOut inside the `quote` sub-object
      const amountOutStr: string | undefined = data.quote?.amountOut;

      if (amountOutStr) {
        const tokens = parseFloat(formatUnits(BigInt(amountOutStr), 18));
        if (tokens > 0) {
          return parseFloat(formatEther(PROBE_ETH_WEI)) / tokens;
        }
      }
    }
  } catch (err) {
    logger.warn({ err, tokenAddress }, "Zora price probe (buy-quote path) failed");
  }

  // ── Strategy 2: /coin indexed price → convert USDC price to ETH ──────────
  try {
    const coinRes = await fetch(
      `${ZORA_QUOTE_API}/coin?chainId=${base.id}&address=${tokenAddress.toLowerCase()}`,
    );
    if (coinRes.ok) {
      const coinData = await coinRes.json();
      // Zora API: price lives at zora20Token.tokenPrice.priceInUsdc
      const priceInUsdc: string | undefined =
        coinData?.zora20Token?.tokenPrice?.priceInUsdc;

      if (priceInUsdc) {
        const tokenPriceUsdc = parseFloat(priceInUsdc);
        if (tokenPriceUsdc > 0) {
          // Derive ETH price: probe 1 ETH → USDC to get current ETH/USDC rate
          const ethUsdcRes = await fetch(`${ZORA_QUOTE_API}/quote`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              chainId: base.id,
              tokenIn: { type: "eth" },
              tokenOut: { type: "erc20", address: USDC_BASE.toLowerCase() },
              amountIn: parseEther("1").toString(),
              slippage: 0.5,
              sender: sender.toLowerCase(),
              recipient: sender.toLowerCase(),
            }),
          });
          if (ethUsdcRes.ok) {
            const ethUsdcData = await ethUsdcRes.json();
            const usdcPerEthStr: string | undefined =
              ethUsdcData.quote?.amountOut;
            if (usdcPerEthStr) {
              const usdcPerEth = parseFloat(formatUnits(BigInt(usdcPerEthStr), USDC_DECIMALS));
              if (usdcPerEth > 0) {
                return tokenPriceUsdc / usdcPerEth; // ETH per token
              }
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err, tokenAddress }, "Zora price probe (coin endpoint) failed");
  }

  return null;
}

/**
 * Approve the Zora router + execute a sell transaction via Zora Quote API.
 * Records sell result in the trades table and broadcasts the update.
 *
 * The Zora API returns sell calldata with a Permit2 EIP-712 placeholder
 * ("REPLACE_WITH_PERMIT_SIGNATURE_1") that must be signed and injected before
 * the tx is submitted. This function handles that automatically.
 */
/**
 * Sell a token position.
 * Primary: Uniswap V4 Universal Router (direct on-chain, no Zora API).
 * Fallback: Zora Quote API (used if V4 poolKey not found in factory events).
 */
export async function executeZoraSell(params: {
  tradeId: number;
  tokenAddress: Address;
  tokenBalance: bigint;
  slippagePercent: number;
  maxGasGwei: number;
  reason: string;
}): Promise<void> {
  try {
    await executeUniversalRouterSell(params);
    return; // sold via Uniswap V4
  } catch (v4Err) {
    logger.warn(
      { tradeId: params.tradeId, err: v4Err instanceof Error ? v4Err.message : String(v4Err) },
      "Universal Router V4 sell failed — falling back to Zora API",
    );
  }
  await executeZoraSellViaApi(params);
}

/** Original Zora Quote API sell — kept as fallback. */
async function executeZoraSellViaApi(params: {
  tradeId: number;
  tokenAddress: Address;
  tokenBalance: bigint;
  slippagePercent: number;
  maxGasGwei: number;
  reason: string;
}): Promise<void> {
  const { tradeId, tokenAddress, tokenBalance, slippagePercent, maxGasGwei, reason } = params;
  const slippage = slippagePercent / 100;
  const account = privateKeyToAccount(getWalletKey());
  const httpUrl = getHttpRpcUrl();
  const publicClient = createPublicClient({ chain: base, transport: http(httpUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(httpUrl) });

  const swapCtx = { tradeId, reason };

  // ── Snapshot USDC balance before sell ────────────────────────────────────
  const usdcBefore = await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  // ── Get sell quote (token → USDC) ─────────────────────────────────────────
  const { call: rawCall, permits } = await fetchZoraSellQuote({
    tokenAddress,
    tokenAmountWei: tokenBalance,
    slippage,
    sender: account.address,
  });

  // ── Handle Permit2 if the API returned permit data ────────────────────────
  //
  // The Zora API builds sell calldata using Permit2 (Uniswap's universal permit
  // router). When permits are returned, `call.data` contains the ASCII placeholder
  // "REPLACE_WITH_PERMIT_SIGNATURE_1" where the 65-byte EIP-712 signature must
  // be injected. Approval must go to the Permit2 contract, not the router.
  let call = rawCall;
  let tokenInAddress: Address | null = tokenAddress; // null → skip approval inside executeZoraSwapTx

  if (permits.length > 0) {
    logger.info({ tradeId, permitsCount: permits.length }, "Signing Permit2 for Zora sell");

    // Approve Permit2 contract to spend tokens (if not already sufficient)
    const permit2Allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, PERMIT2_ADDRESS],
    });
    if (permit2Allowance < tokenBalance) {
      logger.info({ tradeId, spender: PERMIT2_ADDRESS }, "Approving Permit2 contract for sell");
      const approveTx = await walletClient.writeContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [PERMIT2_ADDRESS, maxUint256],
        chain: base,
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
      logger.info({ tradeId, approveTx }, "Permit2 approval confirmed");
    }

    // Sign each permit and inject signature into calldata
    let callData = rawCall.data;
    for (const p of permits) {
      const sig = await walletClient.signTypedData({
        account,
        domain: {
          name: "Permit2",
          chainId: base.id,
          verifyingContract: PERMIT2_ADDRESS,
        },
        types: {
          PermitDetails: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint160" },
            { name: "expiration", type: "uint48" },
            { name: "nonce", type: "uint48" },
          ],
          PermitSingle: [
            { name: "details", type: "PermitDetails" },
            { name: "spender", type: "address" },
            { name: "sigDeadline", type: "uint256" },
          ],
        },
        primaryType: "PermitSingle",
        message: {
          details: {
            token: p.permit.details.token as Address,
            amount: BigInt(p.permit.details.amount),
            expiration: p.permit.details.expiration,
            nonce: p.permit.details.nonce,
          },
          spender: p.permit.spender as Address,
          sigDeadline: BigInt(p.permit.sigDeadline),
        },
      });
      callData = injectPermitSignature(callData, sig);
      logger.info({ tradeId, sigLength: sig.length }, "Permit2 signature injected into calldata");
    }

    call = { ...rawCall, data: callData };
    // Permit2 handles token authorization — skip direct router approval
    tokenInAddress = null;
  }

  const lastTxHash = await executeZoraSwapTx({
    call,
    tokenInAddress,
    tokenInAmount: tokenBalance,
    maxGasGwei,
    publicClient,
    walletClient,
    account,
    logCtx: { ...swapCtx, step: "sell-to-usdc" },
  });

  // ── Calculate USDC received ───────────────────────────────────────────────
  const usdcAfter = await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  const usdcReceived = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n;
  // sellAmountEth field stores USDC received (6 decimals); pnlEth stores same
  const sellAmountUsdc = formatUnits(usdcReceived, USDC_DECIMALS);

  const [updated] = await db
    .update(tradesTable)
    .set({ status: "sold", sellTxHash: lastTxHash, sellAmountEth: sellAmountUsdc, pnlEth: sellAmountUsdc })
    .where(eq(tradesTable.id, tradeId))
    .returning();

  broadcast("trade", updated);
  logger.info(
    { tradeId, sellAmountUsdc, reason },
    "Sniper sell confirmed via Zora API (token → USDC)",
  );
}

// ── executeBuy ──────────────────────────────────────────────────────���─────

export async function executeBuy(params: TradeParams): Promise<void> {
  const {
    tokenAddress,
    tokenName,
    tokenSymbol,
    creatorAddress,
    buyAmountEth,
    slippagePercent,
    maxGasGwei,
    eventName,
    takeProfitPercent,
    stopLossPercent,
  } = params;

  // slippagePercent is stored as e.g. 5.0 → Zora API expects 0.05
  const slippage = slippagePercent / 100;

  logger.info({ tokenAddress, tokenName, buyAmountEth, eventName, slippage }, "Executing buy via Zora Quote API");

  const [tradeRow] = await db
    .insert(tradesTable)
    .values({
      tokenAddress,
      tokenName,
      tokenSymbol,
      creatorAddress,
      buyAmountEth,
      status: "pending",
      takeProfitPercent: takeProfitPercent != null ? String(takeProfitPercent) : null,
      stopLossPercent: stopLossPercent != null ? String(stopLossPercent) : null,
    })
    .returning();

  broadcast("trade", { ...tradeRow, status: "pending" });

  try {
    const account = privateKeyToAccount(getWalletKey());
    const httpUrl = getHttpRpcUrl();
    const publicClient = createPublicClient({ chain: base, transport: http(httpUrl) });
    const walletClient = createWalletClient({ account, chain: base, transport: http(httpUrl) });

    const buyAmountWei = parseEther(buyAmountEth);

    // ── Step 1: Get quote from Zora API ──────��────────────────────────────────
    const call = await fetchZoraQuote({
      tokenAddress,
      buyAmountWei,
      slippage,
      sender: account.address,
    });

    const value = toBigIntSafe(call.value);

    // ── Step 2: Simulate — revert early before spending gas ───────────────────
    try {
      await publicClient.call({
        to: toHex(call.target) as Address,
        data: toHex(call.data),
        value,
        account: account.address,
      });
      logger.info({ tokenAddress }, "Simulation passed");
    } catch (simErr) {
      const msg = simErr instanceof Error ? simErr.message.slice(0, 200) : String(simErr);
      throw new Error(`Simulation reverted — aborting buy: ${msg}`);
    }

    // ── Step 3: EIP-1559 gas — cap at user-configured maxGasGwei ─────────────
    const maxFeeCapWei = BigInt(Math.round(maxGasGwei * 1e9));
    const [feeEstimate, estimatedGas] = await Promise.all([
      publicClient.estimateFeesPerGas(),
      publicClient.estimateGas({
        to: toHex(call.target) as Address,
        data: toHex(call.data),
        value,
        account: account.address,
      }),
    ]);
    const maxFeePerGas =
      feeEstimate.maxFeePerGas < maxFeeCapWei ? feeEstimate.maxFeePerGas : maxFeeCapWei;
    const maxPriorityFeePerGas =
      feeEstimate.maxPriorityFeePerGas < maxFeePerGas
        ? feeEstimate.maxPriorityFeePerGas
        : maxFeePerGas;
    // Buffer 10% di atas estimasi — cegah out-of-gas untuk Uniswap V4 hook calls
    const gasLimit = (estimatedGas * 110n) / 100n;

    logger.info(
      { estimatedGas: estimatedGas.toString(), gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString() },
      "Gas estimated",
    );

    // ── Step 4: Send transaction ───────────────────────────────────────────────
    const txHash = await walletClient.sendTransaction({
      to: toHex(call.target) as Address,
      data: toHex(call.data),
      value,
      chain: base,
      account,
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    logger.info({ txHash, tokenAddress }, "Buy tx submitted");

    // ── Step 5: Wait for receipt ───────────────────────────────────────────────
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    });

    const gasUsedEth = formatEther(
      receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas),
    );

    // ── Step 6: Measure tokens received via balanceOf diff ────────────────────
    let tokenAmount = "";
    try {
      const [balBefore, balAfter] = await Promise.all([
        publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
          blockNumber: receipt.blockNumber - 1n,
        }),
        publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
          blockNumber: receipt.blockNumber,
        }),
      ]);
      const received = balAfter - balBefore;
      if (received > 0n) {
        tokenAmount = formatUnits(received, 18);
        logger.info({ received: received.toString(), tokenAddress }, "Token amount measured via balanceOf diff");
      }
    } catch {
      logger.warn({ tokenAddress }, "balanceOf diff failed — token amount left blank");
    }

    // Calculate entry price: ETH spent ÷ tokens received
    // tokenAmount is already a decimal string from formatUnits (e.g. "1.0"), so
    // parse it directly — BigInt() cannot handle decimal strings and would throw.
    const tokensNum = tokenAmount ? parseFloat(tokenAmount) : 0;
    const ethNum = parseFloat(buyAmountEth);
    const entryPriceEth = tokensNum > 0 ? (ethNum / tokensNum).toFixed(18) : null;

    const success = receipt.status === "success";
    const [updated] = await db
      .update(tradesTable)
      .set({
        txHash,
        status: success ? "confirmed" : "failed",
        gasUsedEth,
        tokenAmount: tokenAmount || null,
        blockNumber: Number(receipt.blockNumber),
        entryPriceEth: success ? entryPriceEth : null,
      })
      .where(eq(tradesTable.id, tradeRow.id))
      .returning();

    if (success) {
      await db
        .update(creatorsTable)
        .set({ totalSniped: sql`total_sniped + 1` })
        .where(eq(creatorsTable.address, creatorAddress));

      const state = botState.get();
      botState.update({
        totalTrades: state.totalTrades + 1,
        snipedToday: state.snipedToday + 1,
        lastEventAt: new Date().toISOString(),
      });

      // ── Start sniper TP/SL monitor (Zora API) — only for sniper trades.
      // Manual trades have their own Li.Fi-based monitor in routes/manual.ts.
      if ((takeProfitPercent || stopLossPercent) && entryPriceEth) {
        monitorTpSlSniper(
          tradeRow.id,
          tokenAddress,
          parseFloat(entryPriceEth),
          takeProfitPercent ?? null,
          stopLossPercent ?? null,
          slippagePercent,
          maxGasGwei,
        ).catch((err) =>
          logger.error({ err, tradeId: tradeRow.id }, "Sniper TP/SL monitor error"),
        );
        logger.info(
          { tradeId: tradeRow.id, takeProfitPercent, stopLossPercent, entryPriceEth },
          "Sniper TP/SL monitor started (Zora API)",
        );
      }
    } else {
      botState.update({ lastEventAt: new Date().toISOString() });
    }

    broadcast("trade", updated);
    logger.info({ txHash, status: updated.status, tokenName }, "Buy settled");
  } catch (err) {
    const failReason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    logger.error({ err, tokenAddress, failReason }, "Buy failed");
    const [updated] = await db
      .update(tradesTable)
      .set({ status: "failed", failReason })
      .where(eq(tradesTable.id, tradeRow.id))
      .returning();

    botState.update({ lastEventAt: new Date().toISOString() });
    broadcast("trade", updated);
  }
}

export async function getWalletBalance(): Promise<{ address: string; balanceEth: string } | null> {
  try {
    const account = privateKeyToAccount(getWalletKey());
    const publicClient = createPublicClient({ chain: base, transport: http(getHttpRpcUrl()) });
    const balanceWei = await publicClient.getBalance({ address: account.address });
    return {
      address: account.address,
      balanceEth: formatEther(balanceWei),
    };
  } catch {
    return null;
  }
}

export function getWalletAddress(): string | null {
  try {
    const account = privateKeyToAccount(getWalletKey());
    return account.address;
  } catch {
    return null;
  }
}

// ── Sniper TP/SL monitor (Zora API) ──────────────────────────────────────
//
// Separate from the manual trade Li.Fi monitor in routes/manual.ts.
// New Zora coins are not yet indexed by Li.Fi, so price detection via Li.Fi
// would always return null. This monitor uses the Zora Quote API for both
// price probing and the actual sell execution.

/**
 * Background TP/SL monitor for a sniper-bought position.
 * Polls current price via Zora API every 15 seconds.
 * Executes sell (also via Zora API) when TP or SL is hit.
 * Retries sell up to 3 times on failure before giving up.
 */
export async function monitorTpSlSniper(
  tradeId: number,
  tokenAddress: Address,
  entryPriceEth: number,
  takeProfitPercent: number | null,
  stopLossPercent: number | null,
  slippagePercent: number,
  maxGasGwei: number,
): Promise<void> {
  if (!takeProfitPercent && !stopLossPercent) return;

  const tpPrice =
    takeProfitPercent != null ? entryPriceEth * (1 + takeProfitPercent / 100) : null;
  const slPrice =
    stopLossPercent != null ? entryPriceEth * (1 - stopLossPercent / 100) : null;

  logger.info(
    { tradeId, entryPriceEth, tpPrice, slPrice, takeProfitPercent, stopLossPercent },
    "Sniper TP/SL monitor started (Zora API)",
  );

  const account = privateKeyToAccount(getWalletKey());
  const publicClient = createPublicClient({ chain: base, transport: http(getHttpRpcUrl()) });

  const POLL_INTERVAL_MS = 15_000;
  const MAX_SELL_ATTEMPTS = 3;
  let sellAttempts = 0;
  let active = true;

  while (active) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      // Bail if trade was already closed externally (manual sell, etc.)
      const [trade] = await db
        .select({ status: tradesTable.status })
        .from(tradesTable)
        .where(eq(tradesTable.id, tradeId));

      if (!trade || trade.status !== "confirmed") {
        logger.info(
          { tradeId, status: trade?.status },
          "Sniper TP/SL monitor: trade no longer active — exiting",
        );
        return;
      }

      // ── Price probe via Zora API ─────────────────────────────────────────
      const currentPrice = await fetchZoraPriceProbe(tokenAddress, account.address);

      if (currentPrice === null) {
        // Expected for very new tokens; pool needs a few more blocks to be indexed
        logger.debug(
          { tradeId, tokenAddress },
          "Sniper TP/SL: price probe null — pool may still be initialising, retrying",
        );
        continue;
      }

      logger.debug({ tradeId, currentPrice, tpPrice, slPrice }, "Sniper TP/SL price check");

      // ── Check trigger ────────────────────────────────────────────────────
      let reason: "take_profit" | "stop_loss" | null = null;
      if (tpPrice !== null && currentPrice >= tpPrice) reason = "take_profit";
      else if (slPrice !== null && currentPrice <= slPrice) reason = "stop_loss";

      if (!reason) continue;

      active = false;
      logger.info(
        { tradeId, reason, currentPrice, tpPrice, slPrice },
        "Sniper TP/SL triggered — executing sell via Zora API",
      );

      // ── Read current token balance ────────────────────────────────────────
      const tokenBalance = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });

      if (tokenBalance === 0n) {
        logger.warn({ tradeId }, "Sniper TP/SL: zero balance — position already closed externally");
        await db
          .update(tradesTable)
          .set({ status: "sold", failReason: "Balance zero at TP/SL trigger" })
          .where(eq(tradesTable.id, tradeId));
        return;
      }

      // ── Execute sell via Zora API ────────────────────────────────────────
      try {
        await executeZoraSell({
          tradeId,
          tokenAddress,
          tokenBalance,
          slippagePercent,
          maxGasGwei,
          reason,
        });
      } catch (sellErr) {
        sellAttempts++;
        logger.error(
          { sellErr, tradeId, sellAttempts, maxAttempts: MAX_SELL_ATTEMPTS },
          "Sniper TP/SL sell attempt failed",
        );
        if (sellAttempts >= MAX_SELL_ATTEMPTS) {
          logger.error({ tradeId }, "Sniper TP/SL: max sell attempts reached — monitor exiting");
          return;
        }
        // Re-activate to retry on the next poll cycle
        active = true;
      }
    } catch (err) {
      logger.error({ err, tradeId }, "Sniper TP/SL monitor cycle error");
    }
  }
}

/**
 * On server restart, re-attach Zora-based TP/SL monitors for confirmed sniper
 * trades that still have TP or SL set. Mirrors recoverTpSlMonitors in
 * routes/manual.ts but targets source='sniper' and uses the Zora API monitor.
 */
export async function recoverSniperTpSlMonitors(): Promise<void> {
  try {
    const openTrades = await db
      .select()
      .from(tradesTable)
      .where(
        and(
          eq(tradesTable.source, "sniper"),
          eq(tradesTable.status, "confirmed"),
        ),
      );

    const recoverable = openTrades.filter(
      (t) => (t.takeProfitPercent || t.stopLossPercent) && t.entryPriceEth,
    );

    if (recoverable.length === 0) {
      logger.info("Sniper TP/SL recovery: no active monitors to restart");
      return;
    }

    logger.info({ count: recoverable.length }, "Sniper TP/SL recovery: restarting monitors");

    // Read current config for slippage/gas (applied at sell time)
    const config = await loadConfig();

    for (const trade of recoverable) {
      const entryPrice = parseFloat(trade.entryPriceEth!);
      const tp = trade.takeProfitPercent ? parseFloat(trade.takeProfitPercent) : null;
      const sl = trade.stopLossPercent ? parseFloat(trade.stopLossPercent) : null;

      monitorTpSlSniper(
        trade.id,
        trade.tokenAddress as Address,
        entryPrice,
        tp,
        sl,
        config.slippagePercent,
        config.maxGasGwei,
      ).catch((err) =>
        logger.error({ err, tradeId: trade.id }, "Sniper TP/SL recovery monitor error"),
      );

      logger.info(
        { tradeId: trade.id, token: trade.tokenAddress, tp, sl },
        "Sniper TP/SL monitor recovered",
      );
    }
  } catch (err) {
    logger.error({ err }, "Sniper TP/SL recovery failed — monitors not restarted");
  }
}
