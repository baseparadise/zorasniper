import { useState } from "react";
import { useListTrades } from "@workspace/api-client-react";
import { formatEth, formatAddress, getBasescanTxLink } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExternalLink, ChevronLeft, ChevronRight, Hash } from "lucide-react";

type TradeStatusFilter = "all" | "pending" | "confirmed" | "failed" | "sold";

export default function Trades() {
  const [statusFilter, setStatusFilter] = useState<TradeStatusFilter>("all");
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const params = {
    limit: LIMIT,
    offset,
    ...(statusFilter !== "all" ? { status: statusFilter as any } : {})
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
          <Select value={statusFilter} onValueChange={(val) => { setStatusFilter(val as TradeStatusFilter); setOffset(0); }}>
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
                <TableCell colSpan={8} className="text-center h-32 text-muted-foreground">Loading records...</TableCell>
              </TableRow>
            ) : trades.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center h-32 text-muted-foreground">No trades found.</TableCell>
              </TableRow>
            ) : (
              trades.map((trade) => (
                <TableRow key={trade.id}>
                  <TableCell className="font-mono text-muted-foreground text-xs">#{trade.id}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {new Date(trade.timestamp).toLocaleString(undefined, { 
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' 
                    })}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium text-sm">{trade.tokenName}</span>
                      <span className="text-xs font-mono text-muted-foreground">{trade.tokenSymbol}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{formatAddress(trade.creatorAddress)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{formatEth(trade.buyAmountEth)}</TableCell>
                  <TableCell className="text-center">
                    <Badge variant={
                      trade.status === "confirmed" ? "success" :
                      trade.status === "sold" ? "default" :
                      trade.status === "pending" ? "pending" : "destructive"
                    } className="uppercase text-[10px] w-20 justify-center">
                      {trade.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {trade.pnlEth ? (
                      <span className={parseFloat(trade.pnlEth) > 0 ? "text-green-600" : parseFloat(trade.pnlEth) < 0 ? "text-red-600" : ""}>
                        {parseFloat(trade.pnlEth) > 0 ? "+" : ""}{formatEth(trade.pnlEth)}
                      </span>
                    ) : "-"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-center gap-2">
                      {trade.txHash ? (
                        <a href={getBasescanTxLink(trade.txHash)} target="_blank" rel="noreferrer" title="Buy TX" className="text-blue-500 hover:text-blue-700">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      ) : <span className="w-4" />}
                      {trade.sellTxHash ? (
                        <a href={getBasescanTxLink(trade.sellTxHash)} target="_blank" rel="noreferrer" title="Sell TX" className="text-orange-500 hover:text-orange-700">
                          <Hash className="h-4 w-4" />
                        </a>
                      ) : <span className="w-4" />}
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
