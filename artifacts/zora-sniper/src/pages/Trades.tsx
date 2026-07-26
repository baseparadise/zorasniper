import { useState } from "react";
import { useListTrades } from "@workspace/api-client-react";
import { formatEth, formatAddress, getBasescanTxLink, getBasescanAddressLink, getZoraTokenLink } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ExternalLink, ChevronLeft, ChevronRight, Hash, Copy, Check } from "lucide-react";

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
            className="inline-flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            {copied
              ? <Check className="h-3 w-3 text-green-500" />
              : <Copy className="h-3 w-3" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {copied ? "Copied!" : (label ?? "Copy")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
    <div className="px-3 py-5 space-y-4 w-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Trade History</h1>
          <p className="text-muted-foreground text-xs mt-0.5">Log of all automated snipes.</p>
        </div>
        <Select
          value={statusFilter}
          onValueChange={(val) => {
            setStatusFilter(val as TradeStatusFilter);
            setOffset(0);
          }}
        >
          <SelectTrigger className="w-[140px] bg-card text-xs h-8">
            <SelectValue placeholder="Filter status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="sold">Sold</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* List */}
      <div className="rounded-lg border border-border overflow-hidden">
        {isLoading ? (
          <div className="text-center py-16 text-muted-foreground text-sm">Loading records...</div>
        ) : trades.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm">No trades found.</div>
        ) : (
          trades.map((trade) => {
            const pnl = trade.pnlEth ? parseFloat(trade.pnlEth) : null;

            return (
              <div
                key={trade.id}
                className="flex items-start justify-between gap-3 px-3 py-3 border-b-2 border-border last:border-b-0 hover:bg-muted/10 transition-colors"
              >
                {/* LEFT: id + token info */}
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  {/* ID */}
                  <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0 mt-0.5 w-6 text-right">
                    #{trade.id}
                  </span>

                  {/* Token details stacked */}
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-sm leading-tight truncate">{trade.tokenName}</div>
                    <div className="text-xs font-mono text-muted-foreground leading-tight">{trade.tokenSymbol}</div>

                    {/* CA */}
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-[10px] font-mono text-muted-foreground/60 leading-none">
                        {formatAddress(trade.tokenAddress)}
                      </span>
                      <CopyButton text={trade.tokenAddress} label="Copy CA" />
                    </div>

                    {/* Date below CA */}
                    <div className="text-[10px] text-muted-foreground/50 leading-none mt-0.5">
                      {new Date(trade.timestamp).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </div>

                    {/* Creator */}
                    <div className="text-[10px] font-mono text-muted-foreground/50 leading-none mt-0.5">
                      {formatAddress(trade.creatorAddress)}
                    </div>
                  </div>
                </div>

                {/* RIGHT: status, buy, pnl, links */}
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  {/* Status badge */}
                  <Badge
                    variant={
                      trade.status === "confirmed"
                        ? "success"
                        : trade.status === "sold"
                        ? "default"
                        : trade.status === "pending"
                        ? "pending"
                        : "destructive"
                    }
                    className="uppercase text-[9px] px-1.5 py-0 h-4"
                  >
                    {trade.status}
                  </Badge>

                  {/* Buy + PNL */}
                  <div className="text-right">
                    <div className="font-mono text-xs text-muted-foreground">
                      {formatEth(trade.buyAmountEth)} ETH
                    </div>
                    {pnl !== null ? (
                      <div
                        className={[
                          "font-mono text-xs font-medium",
                          pnl > 0 ? "text-green-500" : pnl < 0 ? "text-red-500" : "text-muted-foreground",
                        ].join(" ")}
                      >
                        {pnl > 0 ? "+" : ""}{formatEth(trade.pnlEth!)}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground/40">—</div>
                    )}
                  </div>

                  {/* Links row */}
                  <div className="flex items-center gap-1.5">
                    {/* Buy TX */}
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {trade.txHash ? (
                            <a
                              href={getBasescanTxLink(trade.txHash)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-500 hover:text-blue-700 transition-colors"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          ) : (
                            <span className="text-muted-foreground/25">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </span>
                          )}
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          {trade.txHash ? "Basescan — Buy TX" : "No TX yet"}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    {/* Sell TX */}
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {trade.sellTxHash ? (
                            <a
                              href={getBasescanTxLink(trade.sellTxHash)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-orange-500 hover:text-orange-700 transition-colors"
                            >
                              <Hash className="h-3.5 w-3.5" />
                            </a>
                          ) : (
                            <span className="text-muted-foreground/25">
                              <Hash className="h-3.5 w-3.5" />
                            </span>
                          )}
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          {trade.sellTxHash ? "Basescan — Sell TX" : "No sell TX"}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    {/* Zora */}
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <a
                            href={getZoraTokenLink(trade.tokenAddress)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-purple-500 hover:text-purple-700 transition-colors"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M3 4h18v2.5L8.5 18H21v2H3v-2.5L14.5 6H3V4z" />
                            </svg>
                          </a>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">View on Zora</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    {/* Basescan contract */}
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <a
                            href={getBasescanAddressLink(trade.tokenAddress)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-500 hover:text-sky-700 transition-colors"
                          >
                            <svg
                              width="14" height="14" viewBox="0 0 24 24"
                              fill="none" stroke="currentColor" strokeWidth="2"
                              strokeLinecap="round" strokeLinejoin="round"
                            >
                              <rect x="3" y="3" width="7" height="7" />
                              <rect x="14" y="3" width="7" height="7" />
                              <rect x="3" y="14" width="7" height="7" />
                              <path d="M14 17h3m0 0h3m-3 0v-3m0 3v3" />
                            </svg>
                          </a>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Basescan — Token Contract</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Showing {offset + 1}–{offset + trades.length}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handlePrev} disabled={offset === 0}>
            <ChevronLeft className="h-4 w-4 mr-1" /> Prev
          </Button>
          <Button variant="outline" size="sm" onClick={handleNext} disabled={trades.length < LIMIT}>
            Next <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
