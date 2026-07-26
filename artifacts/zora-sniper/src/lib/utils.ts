import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatEth(val: string | number | null | undefined, decimals = 4): string {
  if (val == null) return "0.0000";
  const num = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(num)) return "0.0000";
  return num.toFixed(decimals);
}

export function formatAddress(address: string | null | undefined): string {
  if (!address) return "";
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function getBasescanTxLink(txHash: string) {
  return `https://basescan.org/tx/${txHash}`;
}

export function getBasescanAddressLink(address: string) {
  return `https://basescan.org/address/${address}`;
}

/** Link to the token's page on Zora (Base network). */
export function getZoraTokenLink(tokenAddress: string) {
  return `https://zora.co/coin/base:${tokenAddress}`;
}

export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
