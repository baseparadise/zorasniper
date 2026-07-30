import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWebSocket } from "@/hooks/useWebSocket";
import {
  useManualBuy,
  useListPositions,
  useGetTokenInfo,
  useMarketSell,
  useUpdateTpSl,
  getListPositionsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { cn, formatEth, formatAddress, getBasescanTxLink, getBasescanAddressLink, getZoraTokenLink } from "@/lib/utils";
import {
  ShoppingCart, TrendingUp, TrendingDown, ExternalLink,
  Loader2, Target, ShieldAlert, RefreshCw,
  AlertCircle, CheckCircle2, Clock, Pencil, X, Check, DollarSign,
} from "lucide-react";
import zoraLogo from "@/assets/zora-logo.png";
import basescanLogo from "@/assets/basescan-logo.png";

function formatUsd(val: number): string {
  if (val === 0) return "—";
  if (val < 0.000001) {
    // Show enough decimal places to display 3 significant figures.
    // e.g. 1.5e-7 → $0.000000150  (not scientific notation)
    const decimals = Math.min(Math.max(6, Math.ceil(-Math.log10(val)) + 2), 12);
    return `$${val.toFixed(decimals)}`;
  }
  if (val < 0.01) return `$${val.toFixed(6)}`;
  if (val < 1) return `$${val.toFixed(4)}`;
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(2)}K`;
  return `$${val.toFixed(2)}`;
}

// ── Token preview card ─────────────────────────────────────────────────────

function TokenPreview({ address }: { address: string }) {
  const { data, isLoading, isError } = useGetTokenInfo(address, {
    query: { enabled: /^0x[0-9a-fA-F]{40}$/.test(address) },
  });

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 flex items-center gap-3">
        <Loader2 className="w-4 h-4 text-violet-400 animate-spin shrink-0" />
        <span className="text-white/40 text-sm">Fetching token info...</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 flex items-center gap-3">
        <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
        <span className="text-red-400 text-sm">Could not fetch token info. Check the address.</span>
      </div>
    );
  }

  const priceUsdNum = parseFloat(data.priceUsd ?? "0");
  const mcUsdNum = parseFloat(data.mcUsd ?? "0");
  const walletNum = parseFloat(data.walletBalance);

  return (
    <div className="rounded-2xl border border-violet-500/20 bg-violet-500/5 p-4 space-y-3">
      {/* Token identity */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-white font-bold text-base">{data.name}</p>
          <p className="text-violet-400/70 text-xs font-mono mt-0.5">{data.symbol}</p>
        </div>
        <div className="flex items-center gap-2">
          <a href={getZoraTokenLink(address)} target="_blank" rel="noreferrer"
            className="w-7 h-7 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
            <img src={zoraLogo} alt="Zora" className="h-4 w-4 rounded-full object-contain" />
          </a>
          <a href={getBasescanAddressLink(address)} target="_blank" rel="noreferrer"
            className="w-7 h-7 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
            <img src={basescanLogo} alt="Basescan" className="h-4 w-4 rounded-full object-contain" />
          </a>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-white/5 p-2.5 text-center">
          <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">Price</p>
          <p className="text-white font-mono text-xs font-semibold">
            {formatUsd(priceUsdNum)}
          </p>
        </div>
        <div className="rounded-xl bg-white/5 p-2.5 text-center">
          <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">MC</p>
          <p className="text-white font-mono text-xs font-semibold">
            {formatUsd(mcUsdNum)}
          </p>
        </div>
        <div className="rounded-xl bg-white/5 p-2.5 text-center">
          <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">Held</p>
          <p className="text-white font-mono text-xs font-semibold">
            {walletNum > 0 ? walletNum.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "0"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Position card ──────────────────────────────────────────────────────────

function PositionCard({ position, onRefresh }: { position: any; onRefresh: () => void }) {
  const { trade, currentBalanceTokens, currentValueUsdc, pnlPercent, entryPriceEth } = position;

  // Price + MC + est. value come directly from the /positions response.
  // The backend makes a single Zora /coin API call per position and returns
  // priceUsd, mcUsd, and currentValueUsdc — no extra /token/:address call needed.
  const livePriceUsd = position.priceUsd ? parseFloat(position.priceUsd as string) : null;
  const liveMcUsd = position.mcUsd ? parseFloat(position.mcUsd as string) : null;

  // Est. value: backend already computed balance × currentPrice, use it directly
  const liveValueUsd = (() => {
    const usdc = parseFloat((currentValueUsdc as string) ?? "0");
    return usdc > 0 ? usdc : null;
  })();

  // PnL%: same basis as TP/SL monitor (liveValueUsd vs entryValueUsdc)
  const livePnlPct = (() => {
    if (liveValueUsd === null) return pnlPercent;
    const entryUsdc = trade.entryValueUsdc ? parseFloat(trade.entryValueUsdc) : null;
    if (!entryUsdc || entryUsdc <= 0) return pnlPercent;
    return ((liveValueUsd - entryUsdc) / entryUsdc) * 100;
  })();
  const livePnlPositive = livePnlPct > 0;
  const livePnlZero = Math.abs(livePnlPct) < 0.01;
  const pnlPositive = pnlPercent > 0;
  const pnlZero = pnlPercent === 0;

  const tpNum = trade.takeProfitPercent ? parseFloat(trade.takeProfitPercent) : null;
  const slNum = trade.stopLossPercent ? parseFloat(trade.stopLossPercent) : null;
  const balNum = parseFloat(currentBalanceTokens);

  // Sell confirmation state: idle → confirm → selling
  const [sellState, setSellState] = useState<"idle" | "confirm">("idle");

  // Edit TP/SL state
  const [editingTpSl, setEditingTpSl] = useState(false);
  const [tpInput, setTpInput] = useState(tpNum != null ? String(tpNum) : "");
  const [slInput, setSlInput] = useState(slNum != null ? String(slNum) : "");

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const marketSell = useMarketSell({
    mutation: {
      onSuccess: () => {
        toast({ title: "Sell submitted", description: `${trade.tokenSymbol} — selling at market` });
        setSellState("idle");
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: getListPositionsQueryKey() });
          onRefresh();
        }, 3000);
      },
      onError: (err: any) => {
        toast({ title: "Sell failed", description: err?.message ?? "Unknown error", variant: "destructive" });
        setSellState("idle");
      },
    },
  });

  const updateTpSl = useUpdateTpSl({
    mutation: {
      onSuccess: () => {
        toast({ title: "TP/SL updated", description: `${trade.tokenSymbol} — monitor restarted` });
        setEditingTpSl(false);
        queryClient.invalidateQueries({ queryKey: getListPositionsQueryKey() });
        onRefresh();
      },
      onError: (err: any) => {
        toast({ title: "Update failed", description: err?.message ?? "Unknown error", variant: "destructive" });
      },
    },
  });

  const handleSell = () => {
    if (sellState === "idle") {
      setSellState("confirm");
      return;
    }
    marketSell.mutate({ id: trade.id });
  };

  const handleSaveTpSl = () => {
    updateTpSl.mutate({
      id: trade.id,
      data: {
        takeProfitPercent: tpInput ? parseFloat(tpInput) : null,
        stopLossPercent: slInput ? parseFloat(slInput) : null,
      },
    });
  };

  const handleCancelEdit = () => {
    setTpInput(tpNum != null ? String(tpNum) : "");
    setSlInput(slNum != null ? String(slNum) : "");
    setEditingTpSl(false);
  };

  const isSelling = marketSell.isPending;
  const isSavingTpSl = updateTpSl.isPending;

  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 space-y-3 hover:border-white/12 transition-all">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white font-semibold text-sm truncate">
              {trade.tokenName}
            </span>
            <span className="text-violet-400/70 text-xs font-mono bg-violet-500/10 px-1.5 py-0.5 rounded shrink-0">
              {trade.tokenSymbol}
            </span>
            <StatusPill status={trade.status} />
          </div>
          <p className="text-white/25 text-[11px] font-mono mt-0.5">
            {formatAddress(trade.tokenAddress)}
          </p>
        </div>

        {/* Links */}
        <div className="flex items-center gap-1.5 shrink-0">
          <a href={getZoraTokenLink(trade.tokenAddress)} target="_blank" rel="noreferrer"
            className="w-6 h-6 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
            <img src={zoraLogo} alt="Zora" className="h-3.5 w-3.5 rounded-full object-contain" />
          </a>
          <a href={getBasescanAddressLink(trade.tokenAddress)} target="_blank" rel="noreferrer"
            className="w-6 h-6 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
            <img src={basescanLogo} alt="Basescan" className="h-3.5 w-3.5 rounded-full object-contain" />
          </a>
          {trade.txHash && (
            <a href={getBasescanTxLink(trade.txHash)} target="_blank" rel="noreferrer"
              className="w-6 h-6 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
              <ExternalLink className="w-3 h-3 text-white/40" />
            </a>
          )}
        </div>
      </div>

      {/* Price / MC — live from Zora /coin API, refreshed every 30 s */}
      {(livePriceUsd !== null || liveMcUsd !== null) && (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-white/5 p-2.5">
            <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">Price</p>
            <p className="text-white font-mono text-xs font-semibold">
              {livePriceUsd !== null && livePriceUsd > 0 ? formatUsd(livePriceUsd) : "—"}
            </p>
          </div>
          <div className="rounded-xl bg-white/5 p-2.5">
            <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">MC</p>
            <p className="text-white font-mono text-xs font-semibold">
              {liveMcUsd !== null && liveMcUsd > 0 ? formatUsd(liveMcUsd) : "—"}
            </p>
          </div>
        </div>
      )}

      {/* Entry / Est. Value (USD real-time = balance × price) */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-white/5 p-2.5">
          <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">Entry</p>
          {trade.entryValueUsdc && parseFloat(trade.entryValueUsdc) > 0 ? (
            <>
              <p className="text-white font-mono text-xs font-semibold">
                {formatUsd(parseFloat(trade.entryValueUsdc))}
              </p>
              <p className="text-white/30 text-[10px] font-mono mt-0.5">{formatEth(trade.buyAmountEth)} ETH</p>
            </>
          ) : (
            <>
              <p className="text-white font-mono text-xs font-semibold">
                {formatEth(trade.buyAmountEth)} ETH
              </p>
              <p className="text-white/30 text-[10px] font-mono mt-0.5">USD not measured</p>
            </>
          )}
        </div>
        <div className="rounded-xl bg-white/5 p-2.5">
          <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">Est. Value</p>
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <p className="text-white font-mono text-xs font-semibold">
              {liveValueUsd !== null ? formatUsd(liveValueUsd) : "—"}
            </p>
            {!livePnlZero && (
              <span className={cn("text-[10px] font-mono font-semibold leading-none", livePnlPositive ? "text-green-400" : "text-red-400")}>
                ({livePnlPositive ? "+" : ""}{livePnlPct.toFixed(1)}%)
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Balance + TP/SL badges */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-white/35 font-mono">
          {balNum > 0 ? balNum.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "0"} tokens held
        </div>
        <div className="flex items-center gap-2">
          {tpNum != null && (
            <div className="flex items-center gap-1 text-[10px] text-green-400 font-mono bg-green-500/10 border border-green-500/20 rounded-lg px-2 py-1">
              <Target className="w-2.5 h-2.5" />
              TP {tpNum}%
            </div>
          )}
          {slNum != null && (
            <div className="flex items-center gap-1 text-[10px] text-red-400 font-mono bg-red-500/10 border border-red-500/20 rounded-lg px-2 py-1">
              <ShieldAlert className="w-2.5 h-2.5" />
              SL {slNum}%
            </div>
          )}
        </div>
      </div>

      {/* ── Edit TP/SL panel ── */}
      {editingTpSl && (
        <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-3 space-y-3">
          <p className="text-violet-300 text-[11px] font-semibold uppercase tracking-wider">Edit TP / SL</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-white/40 text-[10px] uppercase tracking-wider block mb-1">
                Take Profit %
              </label>
              <input
                type="number"
                min="0"
                step="5"
                placeholder="e.g. 50"
                value={tpInput}
                onChange={(e) => setTpInput(e.target.value)}
                className="w-full h-8 rounded-lg bg-white/5 border border-white/10 text-white text-xs font-mono px-2 outline-none focus:border-violet-500/50 placeholder-white/20"
              />
            </div>
            <div>
              <label className="text-white/40 text-[10px] uppercase tracking-wider block mb-1">
                Stop Loss %
              </label>
              <input
                type="number"
                min="0"
                max="100"
                step="5"
                placeholder="e.g. 20"
                value={slInput}
                onChange={(e) => setSlInput(e.target.value)}
                className="w-full h-8 rounded-lg bg-white/5 border border-white/10 text-white text-xs font-mono px-2 outline-none focus:border-violet-500/50 placeholder-white/20"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveTpSl}
              disabled={isSavingTpSl}
              className="flex-1 h-8 rounded-lg bg-violet-600/40 hover:bg-violet-600/60 border border-violet-500/30 text-violet-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition-all disabled:opacity-50"
            >
              {isSavingTpSl ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Check className="w-3 h-3" />
              )}
              Save
            </button>
            <button
              onClick={handleCancelEdit}
              disabled={isSavingTpSl}
              className="h-8 px-3 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/40 text-xs flex items-center gap-1.5 transition-all"
            >
              <X className="w-3 h-3" />
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Action buttons ── */}
      <div className="flex items-center gap-2">
        {/* Edit TP/SL button */}
        <button
          onClick={() => { setEditingTpSl((v) => !v); setSellState("idle"); }}
          disabled={isSelling}
          className={cn(
            "flex-1 h-9 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all",
            editingTpSl
              ? "bg-violet-600/20 border-violet-500/40 text-violet-300"
              : "bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:border-white/20"
          )}
        >
          <Pencil className="w-3 h-3" />
          {tpNum != null || slNum != null ? "Edit TP/SL" : "Set TP/SL"}
        </button>

        {/* Sell Market button — two-step confirm */}
        {sellState === "idle" ? (
          <button
            onClick={handleSell}
            disabled={isSelling || balNum === 0}
            className="flex-1 h-9 rounded-xl bg-red-600/20 hover:bg-red-600/35 border border-red-500/30 text-red-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <DollarSign className="w-3 h-3" />
            Sell Market
          </button>
        ) : (
          <div className="flex-1 flex items-center gap-1.5">
            <button
              onClick={handleSell}
              disabled={isSelling}
              className="flex-1 h-9 rounded-xl bg-red-600/70 hover:bg-red-600/90 border border-red-500/60 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-all disabled:opacity-50 animate-pulse"
            >
              {isSelling ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Check className="w-3 h-3" />
              )}
              {isSelling ? "Selling..." : "Confirm Sell"}
            </button>
            <button
              onClick={() => setSellState("idle")}
              disabled={isSelling}
              className="h-9 px-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white/40 flex items-center transition-all"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: any; label: string }> = {
    confirmed: { cls: "bg-green-500/10 border-green-500/20 text-green-400", icon: CheckCircle2, label: "CONFIRMED" },
    pending:   { cls: "bg-amber-500/10 border-amber-500/20 text-amber-400", icon: Clock, label: "PENDING" },
    failed:    { cls: "bg-red-500/10 border-red-500/20 text-red-400", icon: AlertCircle, label: "FAILED" },
  };
  const cfg = map[status] ?? map.pending;
  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[9px] font-bold tracking-wider", cfg.cls)}>
      <Icon className="w-2.5 h-2.5" />
      {cfg.label}
    </span>
  );
}

// ── Main Trade page ────────────────────────────────────────────────────────

export default function Trade() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const manualBuy = useManualBuy();
  const { subscribe } = useWebSocket();

  const [ca, setCa] = useState("");
  const [ethAmount, setEthAmount] = useState("0.01");
  const [slippage, setSlippage] = useState("5");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");

  // WebSocket: invalidate positions immediately when monitor auto-sells (TP/SL triggered)
  useEffect(() => {
    const unsub = subscribe("trade", () => {
      queryClient.invalidateQueries({ queryKey: getListPositionsQueryKey() });
    });
    return unsub;
  }, [subscribe, queryClient]);

  // WebSocket: receive live price/PnL snapshots from monitor every ~15s
  // Overrides stale /positions poll data so card stays in sync with monitor.
  const [positionOverrides, setPositionOverrides] = useState<Record<number, {
    currentValueUsdc: string;
    pnlPercent: number;
    priceUsd: string;
  }>>({});

  useEffect(() => {
    const unsub = subscribe("position_update", (payload: any) => {
      setPositionOverrides(prev => ({
        ...prev,
        [payload.tradeId]: {
          currentValueUsdc: String(payload.currentValueUsdc),
          pnlPercent: payload.pnlPct,
          priceUsd: String(payload.priceUsd),
        },
      }));
    });
    return unsub;
  }, [subscribe]);

  // Debounce CA for token preview
  const [debouncedCa, setDebouncedCa] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedCa(ca.trim()), 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [ca]);

  const { data: positions = [], isLoading: posLoading, refetch: refetchPositions } = useListPositions({
    query: { refetchInterval: 30_000 },
  });

  const handleBuy = () => {
    const addrOk = /^0x[0-9a-fA-F]{40}$/.test(ca.trim());
    if (!addrOk) { toast({ title: "Invalid address", variant: "destructive" }); return; }
    const ethOk = parseFloat(ethAmount) > 0;
    if (!ethOk) { toast({ title: "Invalid ETH amount", variant: "destructive" }); return; }
    const slipOk = parseFloat(slippage) >= 0 && parseFloat(slippage) <= 100;
    if (!slipOk) { toast({ title: "Slippage must be 0–100", variant: "destructive" }); return; }

    manualBuy.mutate(
      {
        data: {
          tokenAddress: ca.trim(),
          buyAmountEth: ethAmount,
          slippagePercent: parseFloat(slippage),
          takeProfitPercent: tp ? parseFloat(tp) : null,
          stopLossPercent: sl ? parseFloat(sl) : null,
        },
      },
      {
        onSuccess: (trade) => {
          toast({ title: "Buy submitted", description: `${trade.tokenSymbol} — ${ethAmount} ETH pending confirmation` });
          queryClient.invalidateQueries({ queryKey: getListPositionsQueryKey() });
          setCa("");
          setDebouncedCa("");
        },
        onError: (err: any) => {
          toast({ title: "Buy failed", description: err?.message ?? "Unknown error", variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      {/* ── Manual Buy form ── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-600/20 border border-violet-500/20 flex items-center justify-center">
            <ShoppingCart className="w-4 h-4 text-violet-400" />
          </div>
          <div>
            <p className="text-white font-semibold text-sm">Manual Buy</p>
            <p className="text-white/30 text-xs mt-0.5">Execute a buy directly on any Zora token</p>
          </div>
        </div>

        {/* Contract address */}
        <div>
          <label className="text-white/40 text-[10px] uppercase tracking-wider block mb-1.5">
            Contract Address <span className="text-white/20">CA of the Zora token</span>
          </label>
          <input
            type="text"
            placeholder="0x..."
            value={ca}
            onChange={(e) => setCa(e.target.value)}
            className="w-full h-10 rounded-xl bg-white/5 border border-white/10 text-white text-sm font-mono px-3 outline-none focus:border-violet-500/50 placeholder-white/15 transition-all"
          />
        </div>

        {/* Token preview */}
        {debouncedCa && <TokenPreview address={debouncedCa} />}

        {/* Buy amount + slippage */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-white/40 text-[10px] uppercase tracking-wider block mb-1.5">
              Buy Amount <span className="text-white/20">ETH</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.001"
              value={ethAmount}
              onChange={(e) => setEthAmount(e.target.value)}
              className="w-full h-10 rounded-xl bg-white/5 border border-white/10 text-white text-sm font-mono px-3 outline-none focus:border-violet-500/50 transition-all"
            />
          </div>
          <div>
            <label className="text-white/40 text-[10px] uppercase tracking-wider block mb-1.5">
              Slippage <span className="text-white/20">%</span>
            </label>
            <input
              type="number"
              min="0"
              max="50"
              step="1"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              className="w-full h-10 rounded-xl bg-white/5 border border-white/10 text-white text-sm font-mono px-3 outline-none focus:border-violet-500/50 transition-all"
            />
          </div>
        </div>

        {/* TP / SL */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-white/40 text-[10px] uppercase tracking-wider block mb-1.5">
              Take Profit <span className="text-white/20">% (optional)</span>
            </label>
            <input
              type="number"
              min="0"
              step="5"
              placeholder="e.g. 50"
              value={tp}
              onChange={(e) => setTp(e.target.value)}
              className="w-full h-10 rounded-xl bg-white/5 border border-white/10 text-white text-sm font-mono px-3 outline-none focus:border-green-500/40 placeholder-white/15 transition-all"
            />
          </div>
          <div>
            <label className="text-white/40 text-[10px] uppercase tracking-wider block mb-1.5">
              Stop Loss <span className="text-white/20">% (optional)</span>
            </label>
            <input
              type="number"
              min="0"
              step="5"
              placeholder="e.g. 20"
              value={sl}
              onChange={(e) => setSl(e.target.value)}
              className="w-full h-10 rounded-xl bg-white/5 border border-white/10 text-white text-sm font-mono px-3 outline-none focus:border-red-500/40 placeholder-white/15 transition-all"
            />
          </div>
        </div>

        {/* Quick slippage presets */}
        <div className="flex items-center gap-2">
          <span className="text-white/25 text-[11px]">Quick:</span>
          {["1", "3", "5", "10", "20"].map((v) => (
            <button
              key={v}
              onClick={() => setSlippage(v)}
              className={cn(
                "text-[11px] px-2.5 py-1 rounded-lg border font-mono transition-all",
                slippage === v
                  ? "bg-violet-600/30 border-violet-500/40 text-violet-300"
                  : "bg-white/5 border-white/10 text-white/40 hover:text-white/70"
              )}
            >
              {v}%
            </button>
          ))}
        </div>

        {/* Execute button */}
        <button
          onClick={handleBuy}
          disabled={manualBuy.isPending || !ca}
          className="w-full h-12 rounded-2xl bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 text-white font-bold text-sm transition-all shadow-lg shadow-violet-500/20 flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {manualBuy.isPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> SUBMITTING...</>
          ) : (
            <><ShoppingCart className="w-4 h-4" /> EXECUTE BUY</>
          )}
        </button>
      </div>

      {/* ── Open Positions ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-indigo-600/20 border border-indigo-500/20 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <p className="text-white font-semibold text-sm">Open Positions</p>
              <p className="text-white/30 text-xs mt-0.5">Manual buys not yet sold</p>
            </div>
          </div>
          <button
            onClick={() => refetchPositions()}
            className="w-8 h-8 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all"
          >
            <RefreshCw className={cn("w-3.5 h-3.5 text-white/40", posLoading && "animate-spin")} />
          </button>
        </div>

        {posLoading ? (
          <div className="flex items-center justify-center py-10 gap-3">
            <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
            <span className="text-white/30 text-sm">Loading positions...</span>
          </div>
        ) : positions.length === 0 ? (
          <div className="rounded-2xl border border-white/6 bg-white/[0.02] py-12 flex flex-col items-center gap-3">
            <TrendingDown className="w-8 h-8 text-white/15" />
            <p className="text-white/25 text-sm">No open positions</p>
            <p className="text-white/15 text-xs text-center max-w-48">
              Buy a token above and it will appear here once confirmed
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {positions.map((pos: any) => {
              const override = positionOverrides[pos.trade.id];
              const mergedPos = override ? { ...pos, ...override } : pos;
              return (
                <PositionCard key={pos.trade.id} position={mergedPos} onRefresh={() => refetchPositions()} />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
