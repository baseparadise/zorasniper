/**
 * Shared Li.Fi swap helpers — used by both the sniper bot (trader.ts) and
 * the manual trade routes (manual.ts).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
  type Address,
  type Account,
} from "viem";
import { base } from "viem/chains";
import { logger } from "./logger";

// Native ETH pseudo-address used by Li.Fi
export const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export const BASE_CHAIN_ID = 8453;
export const LIFI_INTEGRATOR = "zorasniper001";

// Minimal ERC-20 ABI for allowance + approve
const ERC20_APPROVAL_ABI = [
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

export interface LiFiQuoteResponse {
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
    toAmount: string;
    toAmountMin: string;
    approvalAddress?: string;
    gasCosts?: { amount: string; amountUSD?: string }[];
  };
  action: {
    fromToken: { address: string; decimals: number };
    toToken: { address: string; decimals: number };
    fromAmount: string;
    slippage: number;
  };
  tool?: string;
  id?: string;
}

/**
 * Fetch a swap quote from the Li.Fi API.
 * fromToken / toToken are token addresses; pass ETH_ADDRESS for native ETH.
 */
export async function getLiFiQuote(
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
    slippage: (slippagePercent / 100).toFixed(4),
  });

  const url = `https://li.quest/v1/quote?${params}`;
  logger.info({ url }, "Fetching Li.Fi quote");

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(process.env.LIFI_API_KEY ? { "x-lifi-api-key": process.env.LIFI_API_KEY } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

  const body = (await res.json()) as { message?: string; code?: number } & LiFiQuoteResponse;
  if (!res.ok || !body.transactionRequest) {
    const msg = body.message ?? JSON.stringify(body).slice(0, 300);
    throw new Error(`Li.Fi quote failed (${res.status}): ${msg}`);
  }

  return body;
}

/**
 * Ensure the Li.Fi router has sufficient ERC-20 allowance, approving if needed.
 * No-op for native ETH (fromToken = ETH_ADDRESS).
 *
 * IMPORTANT: pass the full Account object from privateKeyToAccount, not just
 * account.address — viem's writeContract needs the signing key.
 */
export async function ensureApproval(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: Account,
  tokenAddress: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  if (tokenAddress.toLowerCase() === ETH_ADDRESS.toLowerCase()) return;

  const existing = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_APPROVAL_ABI,
    functionName: "allowance",
    args: [account.address as Address, spender],
  });

  if (existing >= amount) {
    logger.info({ tokenAddress, spender, existing: existing.toString() }, "Allowance already sufficient");
    return;
  }

  logger.info({ tokenAddress, spender, amount: amount.toString() }, "Approving Li.Fi spender");
  const approveTx = await walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_APPROVAL_ABI,
    functionName: "approve",
    args: [spender, maxUint256],
    account,
    chain: base,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  logger.info({ approveTx }, "Li.Fi approval confirmed");
}
