import { useState } from "react";
import { useListTrades } from "@workspace/api-client-react";
import { formatEth, formatAddress, getBasescanTxLink, getBasescanAddressLink, getZoraTokenLink } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Trade History</h1>
          <p className="text-muted-foreground mt-2">Comprehensive log of all automated snipes.</p>
        </div>
        <div className="flex items-center gap-4">
          <Select
            value={statusFilter}
            onValueChange={(val) => {
              setStatusFilter(val as TradeStatusFilter);
              setOffset(0);
            }}
          >
            <SelectTrigger className="w-[180px] bg-card">
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
      </div>

      <Card className="overflow-hidden border-border">
        <Table>
          <TableHeader className="bg-muted/30">
            <TableRow>
              <TableHead className="w-16">ID</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Target Creator</TableHead>
              <TableHead className="text-right">Buy (ETH)</TableHead>
              <TableHead className="text-center">Status</TableHead>
              <TableHead className="text-right">PNL</TableHead>
              <TableHead className="text-center">Links</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center h-32 text-muted-foreground">
                  Loading records...
                </TableCell>
              </TableRow>
            ) : trades.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center h-32 text-muted-foreground">
                  No trades found.
                </TableCell>
              </TableRow>
            ) : (
              trades.map((trade) => (
                <TableRow key={trade.id}>
                  {/* ID */}
                  <TableCell className="font-mono text-muted-foreground text-xs">
                    #{trade.id}
                  </TableCell>

                  {/* Time */}
                  <TableCell className="whitespace-nowrap text-sm">
                    {new Date(trade.timestamp).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </TableCell>

                  {/* Token — name + symbol + copyable CA */}
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-sm">{trade.tokenName}</span>
                      <span className="text-xs font-mono text-muted-foreground">{trade.tokenSymbol}</span>
                      {/* Contract address with copy button */}
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-[11px] font-mono text-muted-foreground/70 leading-none">
                          {formatAddress(trade.tokenAddress)}
                        </span>
                        <CopyButton text={trade.tokenAddress} label="Copy contract address" />
                      </div>
                    </div>
                  </TableCell>

                  {/* Target Creator */}
                  <TableCell className="font-mono text-sm">
                    {formatAddress(trade.creatorAddress)}
                  </TableCell>

                  {/* Buy amount */}
                  <TableCell className="text-right font-mono text-sm">
                    {formatEth(trade.buyAmountEth)}
                  </TableCell>

                  {/* Status */}
                  <TableCell className="text-center">
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
                      className="uppercase text-[10px] w-20 justify-center"
                    >
                      {trade.status}
                    </Badge>
                  </TableCell>

                  {/* PNL */}
                  <TableCell className="text-right font-mono text-sm">
                    {trade.pnlEth ? (
                      <span
                        className={
                          parseFloat(trade.pnlEth) > 0
                            ? "text-green-600"
                            : parseFloat(trade.pnlEth) < 0
                            ? "text-red-600"
                            : ""
                        }
                      >
                        {parseFloat(trade.pnlEth) > 0 ? "+" : ""}
                        {formatEth(trade.pnlEth)}
                      </span>
                    ) : (
                      "-"
                    )}
                  </TableCell>

                  {/* Links — Basescan TX, Sell TX, Zora token, Basescan token */}
                  <TableCell>
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
                              <span className="w-4 text-muted-foreground/30">
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
                              <span className="w-4 text-muted-foreground/30">
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
                              {/* Zora "Z" icon as SVG */}
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                xmlns="http://www.w3.org/2000/svg"
                              >
                                <path d="M3 4h18v2.5L8.5 18H21v2H3v-2.5L14.5 6H3V4z" />
                              </svg>
                            </a>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            View on Zora
                          </TooltipContent>
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
                              {/* Contract / block icon */}
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                xmlns="http://www.w3.org/2000/svg"
                              >
                                <rect x="3" y="3" width="7" height="7" />
                                <rect x="14" y="3" width="7" height="7" />
                                <rect x="3" y="14" width="7" height="7" />
                                <path d="M14 17h3m0 0h3m-3 0v-3m0 3v3" />
                              </svg>
                            </a>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            Basescan — Token Contract
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>

                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Showing {offset + 1} to {offset + trades.length}
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
