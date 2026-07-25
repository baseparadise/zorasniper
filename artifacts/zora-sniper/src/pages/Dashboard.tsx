import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useGetDashboard, 
  getGetDashboardQueryKey,
  useStartBot,
  useStopBot,
  BotStatus,
  Trade
} from "@workspace/api-client-react";
import { useWebSocket } from "@/hooks/useWebSocket";
import { formatEth, formatAddress, formatUptime, getBasescanTxLink, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Square, Activity, Wallet, Hash, TrendingUp, TrendingDown, Clock, Crosshair } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Dashboard() {
  const { data, isLoading } = useGetDashboard();
  const queryClient = useQueryClient();
  const { subscribe } = useWebSocket();
  const { toast } = useToast();

  const startBot = useStartBot();
  const stopBot = useStopBot();

  useEffect(() => {
    const unsubStatus = subscribe("status", (payload) => {
      const status = payload as BotStatus;
      queryClient.setQueryData(getGetDashboardQueryKey(), (old: any) => 
        old ? { ...old, botStatus: status } : old
      );
    });

    const unsubTrade = subscribe("trade", (payload) => {
      const trade = payload as Trade;
      queryClient.setQueryData(getGetDashboardQueryKey(), (old: any) => {
        if (!old) return old;
        const exists = old.recentTrades.some((t: Trade) => t.id === trade.id);
        if (exists) {
          return {
            ...old,
            recentTrades: old.recentTrades.map((t: Trade) => t.id === trade.id ? trade : t)
          };
        }
        return {
          ...old,
          recentTrades: [trade, ...old.recentTrades].slice(0, 50)
        };
      });
    });

    return () => {
      unsubStatus();
      unsubTrade();
    };
  }, [subscribe, queryClient]);

  const handleTogglePower = () => {
    if (!data?.botStatus) return;
    
    if (data.botStatus.running) {
      stopBot.mutate(undefined, {
        onSuccess: (status) => {
          queryClient.setQueryData(getGetDashboardQueryKey(), (old: any) => old ? { ...old, botStatus: status } : old);
          toast({ title: "Bot Stopped", description: "The sniper bot is now offline." });
        },
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to stop bot." })
      });
    } else {
      startBot.mutate(undefined, {
        onSuccess: (status) => {
          queryClient.setQueryData(getGetDashboardQueryKey(), (old: any) => old ? { ...old, botStatus: status } : old);
          toast({ title: "Bot Started", description: "The sniper bot is now online and watching." });
        },
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to start bot." })
      });
    }
  };

  if (isLoading || !data) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[50vh]">
        <div className="animate-pulse text-muted-foreground font-mono">INITIALIZING TERMINAL...</div>
      </div>
    );
  }

  const { botStatus, stats, recentTrades } = data;

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          Command Center
          {botStatus.running ? (
            <Badge variant="success" className="animate-pulse flex items-center gap-1.5 px-2.5 py-1 text-xs">
              <Activity className="h-3 w-3" /> ONLINE
            </Badge>
          ) : (
            <Badge variant="secondary" className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground">
              <Square className="h-3 w-3" /> OFFLINE
            </Badge>
          )}
        </h1>
        
        <Button 
          size="lg"
          variant={botStatus.running ? "destructive" : "default"}
          onClick={handleTogglePower}
          disabled={startBot.isPending || stopBot.isPending}
          className="font-bold tracking-widest uppercase w-48 shadow-lg"
        >
          {startBot.isPending || stopBot.isPending ? "WAIT..." : 
            botStatus.running ? (
              <><Square className="h-4 w-4 mr-2" fill="currentColor" /> STOP SYSTEM</>
            ) : (
              <><Play className="h-4 w-4 mr-2" fill="currentColor" /> INITIATE SNIPE</>
            )
          }
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Wallet Balance</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">
              {formatEth(botStatus.walletBalanceEth)} <span className="text-sm text-muted-foreground font-sans">ETH</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1 font-mono truncate" title={botStatus.walletAddress || ""}>
              {formatAddress(botStatus.walletAddress)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total Trades</CardTitle>
            <Hash className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{stats.totalTrades}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.todayTrades} today
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">System Uptime</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{formatUptime(botStatus.uptimeSeconds)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Last event: {botStatus.lastEventAt ? new Date(botStatus.lastEventAt).toLocaleTimeString() : 'Never'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total PNL</CardTitle>
            {parseFloat(stats.totalPnlEth) >= 0 ? 
              <TrendingUp className="h-4 w-4 text-green-500" /> : 
              <TrendingDown className="h-4 w-4 text-red-500" />
            }
          </CardHeader>
          <CardContent>
            <div className={cn(
              "text-2xl font-bold font-mono",
              parseFloat(stats.totalPnlEth) > 0 ? "text-green-600 dark:text-green-500" : 
              parseFloat(stats.totalPnlEth) < 0 ? "text-red-600 dark:text-red-500" : ""
            )}>
              {parseFloat(stats.totalPnlEth) > 0 ? "+" : ""}{formatEth(stats.totalPnlEth)} <span className="text-sm font-sans opacity-70">ETH</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1 font-mono">
              Win Rate: {stats.winRatePercent?.toFixed(1)}%
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border shadow-sm">
        <CardHeader className="border-b border-border bg-muted/20">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Crosshair className="h-5 w-5 text-blue-500" />
              Live Activity Feed
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {recentTrades.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              NO RECENT ACTIVITY
            </div>
          ) : (
            <div className="divide-y divide-border">
              {recentTrades.map((trade) => (
                <div key={trade.id} className="p-4 flex items-center justify-between hover:bg-muted/30 transition-colors">
                  <div className="flex items-center gap-4">
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      trade.status === "confirmed" || trade.status === "sold" ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" :
                      trade.status === "pending" ? "bg-blue-500 animate-pulse shadow-[0_0_8px_rgba(59,130,246,0.6)]" :
                      "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]"
                    )} />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm">{trade.tokenName}</span>
                        <span className="text-xs font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          {trade.tokenSymbol}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 font-mono flex items-center gap-2">
                        {new Date(trade.timestamp).toLocaleTimeString()}
                        <span className="opacity-50">•</span>
                        Creator: {formatAddress(trade.creatorAddress)}
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <div className="text-sm font-mono font-medium">
                        {formatEth(trade.buyAmountEth)} ETH
                      </div>
                      {trade.status === 'sold' && trade.pnlEth && (
                        <div className={cn(
                          "text-xs font-mono mt-0.5",
                          parseFloat(trade.pnlEth) > 0 ? "text-green-500" : "text-red-500"
                        )}>
                          {parseFloat(trade.pnlEth) > 0 ? "+" : ""}{formatEth(trade.pnlEth)} ETH
                        </div>
                      )}
                    </div>
                    
                    <Badge variant={
                      trade.status === "confirmed" ? "success" :
                      trade.status === "sold" ? "default" :
                      trade.status === "pending" ? "pending" : "destructive"
                    } className="uppercase w-20 justify-center">
                      {trade.status}
                    </Badge>

                    {trade.txHash && (
                      <a 
                        href={getBasescanTxLink(trade.txHash)} 
                        target="_blank" 
                        rel="noreferrer"
                        className="text-xs text-blue-500 hover:text-blue-600 hover:underline font-mono"
                      >
                        TX ↗
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
