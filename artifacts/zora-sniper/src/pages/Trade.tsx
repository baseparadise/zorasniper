import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useManualBuy,
  useListPositions,
  useGetTokenInfo,
  getListPositionsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { cn, formatEth, formatAddress, getBasescanTxLink, getBasescanAddressLink, getZoraTokenLink } from "@/lib/utils";
import {
  ShoppingCart, TrendingUp, TrendingDown, ExternalLink,
  Loader2, Target, ShieldAlert, RefreshCw, Crosshair,
  AlertCircle, CheckCircle2, Clock,
} from "lucide-react";
import zoraLogo from "@/assets/zora-logo.png";
import basescanLogo from "@/assets/basescan-logo.png";

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

  const priceNum = parseFloat(data.priceEth);
  const mcNum = parseFloat(data.mcEth);
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
            {priceNum > 0 ? `${priceNum.toExponential(3)} ETH` : "—"}
          </p>
        </div>
        <div className="rounded-xl bg-white/5 p-2.5 text-center">
          <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">MC</p>
          <p className="text-white font-mono text-xs font-semibold">
            {mcNum > 0 ? `${mcNum.toFixed(2)} ETH` : "—"}
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

function PositionCard({ position }: { position: any }) {
  const { trade, currentBalanceTokens, currentValueEth, pnlPercent, entryPriceEth } = position;
  const pnlPositive = pnlPercent > 0;
  const pnlZero = pnlPercent === 0;

  const tpNum = trade.takeProfitPercent ? parseFloat(trade.takeProfitPercent) : null;
  const slNum = trade.stopLossPercent ? parseFloat(trade.stopLossPercent) : null;
  const balNum = parseFloat(currentBalanceTokens);

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

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-white/5 p-2.5">
          <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">Entry</p>
          <p className="text-white font-mono text-xs font-semibold">{formatEth(trade.buyAmountEth)} ETH</p>
          {entryPriceEth && parseFloat(entryPriceEth) > 0 && (
            <p className="text-white/30 text-[10px] font-mono mt-0.5">
              {parseFloat(entryPriceEth).toExponential(3)} ETH/tok
            </p>
          )}
        </div>
        <div className="rounded-xl bg-white/5 p-2.5">
          <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">Est. Value</p>
          <p className="text-white font-mono text-xs font-semibold">
            {parseFloat(currentValueEth) > 0 ? `${formatEth(currentValueEth)} ETH` : "—"}
          </p>
          {!pnlZero && (
            <p className={cn("text-[10px] font-mono mt-0.5", pnlPositive ? "text-green-400" : "text-red-400")}>
              {pnlPositive ? "+" : ""}{pnlPercent.toFixed(2)}%
            </p>
          )}
        </div>
      </div>

      {/* Balance + TP/SL */}
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
    <span className={cn("flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wide shrink-0", cfg.cls)}>
      <Icon className="w-2.5 h-2.5" />
      {cfg.label}
    </span>
  );
}

// ── Input component ────────────────────────────────────────────────────────

function Field({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-white/60 text-xs font-semibold uppercase tracking-wider mb-1.5">
        {label}
        {desc && <span className="text-white/25 normal-case tracking-normal ml-1.5 font-normal">{desc}</span>}
      </label>
      {children}
    </div>
  );
}

const inputCls = "w-full bg-white/[0.07] border border-white/15 rounded-xl text-white placeholder-white/20 text-sm h-11 px-3.5 focus:outline-none focus:ring-1 focus:ring-violet-500/40 focus:border-violet-400/50 font-mono transition-all";

// ── Main page ──────────────────────────────────────────────────────────────

export default function Trade() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const manualBuy = useManualBuy();

  const [ca, setCa] = useState("");
  const [ethAmount, setEthAmount] = useState("0.01");
  const [slippage, setSlippage] = useState("5");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");

  // Debounce CA for token preview
  const [debouncedCa, setDebouncedCa] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedCa(ca.trim()), 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [ca]);

  const { data: positions = [], isLoading: posLoading, refetch: refetchPositions } = useListPositions();

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
          // reset CA
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
    <div className="px-4 py-4 space-y-5">
      {/* ── Buy form ── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-8 h-8 rounded-xl bg-violet-600/20 border border-violet-500/20 flex items-center justify-center">
            <Crosshair className="w-4 h-4 text-violet-400" />
          </div>
          <div>
            <p className="text-white font-semibold text-sm">Manual Buy</p>
            <p className="text-white/30 text-xs mt-0.5">Execute a buy directly on any Zora token</p>
          </div>
        </div>

        {/* Contract Address */}
        <Field label="Contract Address" desc="CA of the Zora token">
          <input
            className={inputCls}
            placeholder="0x..."
            value={ca}
            onChange={(e) => setCa(e.target.value)}
          />
        </Field>

        {/* Token preview */}
        {debouncedCa && <TokenPreview address={debouncedCa} />}

        {/* ETH + Slippage */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Buy Amount" desc="ETH">
            <input
              className={inputCls}
              type="number"
              min="0"
              step="0.001"
              placeholder="0.01"
              value={ethAmount}
              onChange={(e) => setEthAmount(e.target.value)}
            />
          </Field>
          <Field label="Slippage" desc="%">
            <input
              className={inputCls}
              type="number"
              min="0"
              max="100"
              step="0.5"
              placeholder="5"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
            />
          </Field>
        </div>

        {/* TP / SL */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Take Profit" desc="% (optional)">
            <input
              className={cn(inputCls, "text-green-400 placeholder-green-900")}
              type="number"
              min="0"
              step="5"
              placeholder="e.g. 50"
              value={tp}
              onChange={(e) => setTp(e.target.value)}
            />
          </Field>
          <Field label="Stop Loss" desc="% (optional)">
            <input
              className={cn(inputCls, "text-red-400 placeholder-red-900")}
              type="number"
              min="0"
              step="5"
              placeholder="e.g. 20"
              value={sl}
              onChange={(e) => setSl(e.target.value)}
            />
          </Field>
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
            {positions.map((pos: any) => (
              <PositionCard key={pos.trade.id} position={pos} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
