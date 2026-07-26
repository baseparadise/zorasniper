import { useState } from "react";
import { useListTrades } from "@workspace/api-client-react";
import { formatEth, formatAddress, getBasescanTxLink, getBasescanAddressLink, getZoraTokenLink, cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronLeft, ChevronRight, Copy, Check, Clock, Zap, ExternalLink, History } from "lucide-react";
import zoraLogo from "@/assets/zora-logo.png";
import basescanLogo from "@/assets/basescan-logo.png";

type TradeStatusFilter = "all" | "pending" | "confirmed" | "failed" | "sold";

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCopy}
            className="w-7 h-7 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all"
          >
            {copied
              ? <Check className="h-3 w-3 text-green-400" />
              : <Copy className="h-3 w-3 text-white/30" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {copied ? "Copied!" : (label ?? "Copy")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function TradePill({ status }: { status: string }) {
  const map: Record<string, string> = {
    confirmed: "bg-green-500/10 border-green-500/20 text-green-400",
    sold:      "bg-blue-500/10 border-blue-500/20 text-blue-400",
    pending:   "bg-amber-500/10 border-amber-500/20 text-amber-400",
    failed:    "bg-red-500/10 border-red-500/20 text-red-400",
  };
  return (
    <span className={cn(
      "text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wide shrink-0",
      map[status] ?? "bg-white/5 border-white/10 text-white/40"
    )}>
      {status}
    </span>
  );
}

export default function Trades() {
  const [statusFilter, setStatusFilter] = useState<TradeStatusFilter>("all");
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const params = {
    limit: LIMIT,
    offset,
    ...(statusFilter !== "all" ? { status: statusFilter as any } : {}),
  };

  const { data: trades = [], isLoading } = useListTrades(params);

  const handleNext = () => setOffset((p) => p + LIMIT);
  const handlePrev = () => setOffset((p) => Math.max(0, p - LIMIT));

  return (
    <div className="p-4 space-y-4 pb-8">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-white font-bold text-lg">Trade History</h2>
          <p className="text-white/30 text-xs mt-0.5">All automated snipes</p>
        </div>
        <Select
          value={statusFilter}
          onValueChange={(val) => { setStatusFilter(val as TradeStatusFilter); setOffset(0); }}
        >
          <SelectTrigger className="w-36 h-9 rounded-xl bg-white/5 border-white/10 text-white/70 text-xs">
            <SelectValue placeholder="Filter" />
          </SelectTrigger>
          <SelectContent className="bg-[#0d0d1a] border-white/10 text-white rounded-xl">
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="sold">Sold</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* ── Trade cards ── */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-white/8 bg-white/[0.04] h-20 animate-pulse" />
          ))}
        </div>
      ) : trades.length === 0 ? (
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] py-16 flex flex-col items-center gap-3">
          <History className="w-10 h-10 text-white/10" />
          <p className="text-white/25 text-sm">No trades match this filter</p>
        </div>
      ) : (
        <div className="space-y-2">
          {trades.map((trade) => (
            <div key={trade.id} className="rounded-2xl border border-white/8 bg-white/[0.04] overflow-hidden hover:border-white/12 transition-all">
              {/* Main row */}
              <div className="flex items-center gap-3 px-4 py-3.5">
                {/* Avatar */}
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-700 flex items-center justify-center shrink-0 shadow-md shadow-violet-500/20">
                  <Zap className="w-4 h-4 text-white" />
                </div>

                {/* Token info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-semibold text-sm font-mono">
                      {formatAddress(trade.tokenAddress)}
                    </span>
                    <TradePill status={trade.status} />
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Clock className="w-3 h-3 text-white/20" />
                    <span className="text-white/30 text-[11px]">
                      {new Date(trade.timestamp).toLocaleString()}
                    </span>
                  </div>
                </div>

                {/* ETH amount */}
                <div className="flex flex-col items-end shrink-0">
                  <span className="text-white font-mono text-sm font-semibold">
                    {formatEth(trade.buyAmountEth)} ETH
                  </span>
                  {trade.pnlEth ? (
                    <span className={cn(
                      "text-xs font-mono mt-0.5",
                      parseFloat(trade.pnlEth) > 0 ? "text-green-400" : parseFloat(trade.pnlEth) < 0 ? "text-red-400" : "text-white/30"
                    )}>
                      {parseFloat(trade.pnlEth) > 0 ? "+" : ""}{formatEth(trade.pnlEth)}
                    </span>
                  ) : (
                    <span className="text-white/20 text-xs font-mono">—</span>
                  )}
                </div>
              </div>

              {/* Detail row */}
              <div className="flex items-center gap-2 px-4 py-2.5 border-t border-white/5 bg-black/20">
                <span className="text-white/25 text-[11px] font-mono flex-1 truncate">
                  Creator: {formatAddress(trade.creatorAddress)}
                </span>

                <div className="flex items-center gap-2 shrink-0">
                  <CopyButton text={trade.tokenAddress} label="Copy token address" />

                  {/* Basescan buy TX */}
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {trade.txHash ? (
                          <a href={getBasescanTxLink(trade.txHash)} target="_blank" rel="noreferrer"
                            className="w-7 h-7 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                            <img src={basescanLogo} alt="Basescan" className="h-4 w-4 rounded-full object-contain" />
                          </a>
                        ) : (
                          <span className="w-7 h-7 rounded-lg border border-white/5 flex items-center justify-center opacity-25">
                            <img src={basescanLogo} alt="Basescan" className="h-4 w-4 rounded-full object-contain" />
                          </span>
                        )}
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{trade.txHash ? "Buy TX" : "No TX"}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>

                  {/* Basescan sell TX */}
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {trade.sellTxHash ? (
                          <a href={getBasescanTxLink(trade.sellTxHash)} target="_blank" rel="noreferrer"
                            className="w-7 h-7 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                            <img src={basescanLogo} alt="Basescan" className="h-4 w-4 rounded-full object-contain opacity-60" />
                          </a>
                        ) : (
                          <span className="w-7 h-7 rounded-lg border border-white/5 flex items-center justify-center opacity-25">
                            <img src={basescanLogo} alt="Basescan" className="h-4 w-4 rounded-full object-contain" />
                          </span>
                        )}
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{trade.sellTxHash ? "Sell TX" : "No sell TX"}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>

                  {/* Zora link */}
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {trade.tokenAddress ? (
                          <a href={getZoraTokenLink(trade.tokenAddress)} target="_blank" rel="noreferrer"
                            className="w-7 h-7 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                            <img src={zoraLogo} alt="Zora" className="h-4 w-4 rounded-full object-contain" />
                          </a>
                        ) : (
                          <span className="w-7 h-7 rounded-lg border border-white/5 flex items-center justify-center opacity-25">
                            <img src={zoraLogo} alt="Zora" className="h-4 w-4 rounded-full object-contain" />
                          </span>
                        )}
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">View on Zora</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Pagination ── */}
      <div className="flex items-center justify-between pt-2">
        <button
          onClick={handlePrev}
          disabled={offset === 0}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/50 text-xs font-semibold hover:bg-white/8 hover:text-white/70 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> Prev
        </button>
        <span className="text-white/25 text-xs font-mono">
          {offset + 1}–{offset + trades.length}
        </span>
        <button
          onClick={handleNext}
          disabled={trades.length < LIMIT}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/50 text-xs font-semibold hover:bg-white/8 hover:text-white/70 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          Next <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
