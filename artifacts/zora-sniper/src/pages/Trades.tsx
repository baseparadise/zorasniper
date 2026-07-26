import { useState } from "react";
import { useListTrades } from "@workspace/api-client-react";
import { formatEth, formatAddress, getBasescanTxLink, getBasescanAddressLink, getZoraTokenLink } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ExternalLink, ChevronLeft, ChevronRight, Hash, Copy, Check } from "lucide-react";

type TradeStatusFilter = "all" | "pending" | "confirmed" | "failed" | "sold";

/** One-shot copy button: copies text and shows a checkmark for 1.5 s. */
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
              ? <Check className="h-3.5 w-3.5 text-green-500" />
              : <Copy className="h-3.5 w-3.5" />}
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
    <div className="px-4 py-6 space-y-4 w-full overflow-x-hidden">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trade History</h1>
          <p className="text-muted-foreground text-sm mt-1">Comprehensive log of all automated snipes.</p>
        </div>
        <Select
          value={statusFilter}
          onValueChange={(val) => {
            setStatusFilter(val as TradeStatusFilter);
            setOffset(0);
          }}
        >
          <SelectTrigger className="w-[160px] bg-card">
            <SelectValue placeholder="Filter by status" />
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

      {/* Table header */}
      <div className="w-full rounded-lg border border-border overflow-hidden bg-card">
        <div className="grid grid-cols-[3rem_1fr_7rem_5rem_5rem_6rem] bg-muted/40 border-b-2 border-border px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <span>ID</span>
          <span>Token / CA / Date</span>
          <span>Creator</span>
          <span className="text-right">Buy ETH</span>
          <span className="text-center">Status</span>
          <span className="text-center">Links</span>
        </div>

        {/* Rows */}
        {isLoading ? (
          <div className="text-center py-16 text-muted-foreground text-sm">Loading records...</div>
        ) : trades.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm">No trades found.</div>
        ) : (
          trades.map((trade, idx) => (
            <div
              key={trade.id}
              className={[
                "grid grid-cols-[3rem_1fr_7rem_5rem_5rem_6rem] items-center px-3 py-2.5",
                "border-b-2 border-border last:border-b-0",
                idx % 2 === 0 ? "bg-background" : "bg-muted/10",
              ].join(" ")}
            >
              {/* ID */}
              <span className="font-mono text-muted-foreground text-xs">#{trade.id}</span>

              {/* Token + CA + Date stacked */}
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="font-medium text-sm truncate">{trade.tokenName}</span>
                <span className="text-xs font-mono text-muted-foreground truncate">{trade.tokenSymbol}</span>
                {/* CA */}
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-mono text-muted-foreground/60 leading-none">
                    {formatAddress(trade.tokenAddress)}
                  </span>
                  <CopyButton text={trade.tokenAddress} label="Copy contract address" />
                </div>
                {/* Date moved here */}
                <span className="text-[10px] text-muted-foreground/50 leading-none mt-0.5">
                  {new Date(trade.timestamp).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
              </div>

              {/* Creator */}
              <span className="font-mono text-xs text-muted-foreground truncate">
                {formatAddress(trade.creatorAddress)}
              </span>

              {/* Buy amount */}
              <span className="font-mono text-sm text-right">{formatEth(trade.buyAmountEth)}</span>

              {/* Status */}
              <div className="flex justify-center">
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
                  className="uppercase text-[10px] w-[4.5rem] justify-center"
                >
                  {trade.status}
                </Badge>
              </div>

              {/* Links */}
              <div className="flex items-center justify-center gap-2">
                {/* Basescan buy TX */}
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
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground/30">
                          <ExternalLink className="h-4 w-4" />
                        </span>
                      )}
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      {trade.txHash ? "Basescan — Buy TX" : "No TX yet"}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                {/* Basescan sell TX */}
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
                          <Hash className="h-4 w-4" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground/30">
                          <Hash className="h-4 w-4" />
                        </span>
                      )}
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      {trade.sellTxHash ? "Basescan — Sell TX" : "No sell TX"}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                {/* Zora token page */}
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <a
                        href={getZoraTokenLink(trade.tokenAddress)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-purple-500 hover:text-purple-700 transition-colors"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                          <path d="M3 4h18v2.5L8.5 18H21v2H3v-2.5L14.5 6H3V4z" />
                        </svg>
                      </a>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">View on Zora</TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                {/* Basescan token contract */}
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
                          width="16" height="16" viewBox="0 0 24 24"
                          fill="none" stroke="currentColor" strokeWidth="2"
                          strokeLinecap="round" strokeLinejoin="round"
                          xmlns="http://www.w3.org/2000/svg"
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
          ))
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
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
