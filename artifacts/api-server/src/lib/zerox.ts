/**
 * Shared 0x API v2 (Permit2) helpers — used by the sniper bot (trader.ts) and
 * the manual trade routes (manual.ts) as the primary sell aggregator.
 *
 * Docs: https://docs.0x.org/docs/introduction/welcome
 *
 * Chain: Base (8453)
 * Endpoint: https://api.0x.org/swap/permit2/quote
 * Chain header: 0x-chain-id: 8453
 */

import { logger } from "./logger";

export const ZEROX_API_BASE = "https://api.0x.org";
export const BASE_CHAIN_ID = 8453;

/** Native ETH pseudo-address used by 0x (same across all EVM chains). */
export const ZEROX_NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEEE";

/** Permit2 universal contract address (same on all EVM chains). */
export const PERMIT2_ADDRESS =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export interface ZeroXPermit2 {
  /**
   * "Permit2"         → sign eip712 and append signature to tx data
   * "AllowanceHolder" → traditional ERC-20 approve(spender, amount) first
   */
  type: "Permit2" | "AllowanceHolder";
  hash?: string;
  /** Present when type === "Permit2". Contains the typed-data payload to sign. */
  eip712?: {
    types: Record<string, Array<{ name: string; type: string }>>;
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
    primaryType: string;
  };
}

export interface ZeroXQuoteResponse {
  liquidityAvailable?: boolean;
  transaction: {
    to: string;
    data: string;
    value: string;
    gas: string;
    gasPrice?: string;
  };
  permit2?: ZeroXPermit2;
  issues?: {
    /** Non-null when allowance is insufficient for the AllowanceHolder path. */
    allowance?: { actual: string; spender: string } | null;
    balance?: unknown;
    simulationIncomplete?: boolean;
  };
  /** Expected output amount in wei (before slippage). */
  buyAmount?: string;
  /** Minimum output amount in wei (after slippage deduction). */
  minBuyAmount?: string;
}

/** Read the 0x API key from env. Optional — works without one but at lower rate limits. */
function get0xApiKey(): string | undefined {
  return process.env.ZEROX_API_KEY ?? undefined;
}

/**
 * Fetch a swap quote from 0x API v2 Permit2 endpoint.
 *
 * sellToken  : token address to sell (use ZEROX_NATIVE_ETH for native ETH)
 * buyToken   : token address to receive (use ZEROX_NATIVE_ETH for native ETH)
 * sellAmount : exact amount to sell in wei (as bigint)
 * taker      : wallet address that will execute the swap
 * slippageBps: allowed slippage in basis points (e.g. 100 = 1%). Defaults to 100.
 */
export async function get0xSellQuote(params: {
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  taker: string;
  slippageBps?: number;
}): Promise<ZeroXQuoteResponse> {
  const { sellToken, buyToken, sellAmount, taker, slippageBps = 100 } = params;

  const apiKey = get0xApiKey();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "0x-chain-id": String(BASE_CHAIN_ID),
  };
  if (apiKey) headers["0x-api-key"] = apiKey;

  const qs = new URLSearchParams({
    sellToken,
    buyToken,
    sellAmount: sellAmount.toString(),
    taker,
    slippageBps: String(slippageBps),
  });

  const url = `${ZEROX_API_BASE}/swap/permit2/quote?${qs}`;

  logger.info(
    { sellToken, buyToken, sellAmount: sellAmount.toString(), slippageBps },
    "Fetching 0x sell quote",
  );

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await res.json()) as any;

  if (!res.ok) {
    const msg =
      body?.reason ??
      body?.validationErrors?.[0]?.description ??
      JSON.stringify(body).slice(0, 300);
    throw new Error(`0x quote failed (${res.status}): ${msg}`);
  }

  if (!body.transaction) {
    throw new Error(
      `0x quote returned no transaction: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }

  if (body.liquidityAvailable === false) {
    throw new Error("0x: no liquidity available for this swap");
  }

  return body as ZeroXQuoteResponse;
}
