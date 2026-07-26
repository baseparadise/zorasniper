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
import { formatEth, formatAddress, formatUptime, getBasescanTxLink, getBasescanAddressLink, cn } from "@/lib/utils";
import {
  Play, Square, Wallet, Hash, TrendingUp, TrendingDown,
  Clock, Crosshair, ExternalLink, AlertCircle, Zap, BarChart3
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ── Helpers ──────────────────────────────────────────────────────────────────

function StatusPill({ running }: { running: boolean }) {
  return (
    <div className={cn(
      "flex items-center gap-1.5 rounded-full px-2.5 py-1 border text-xs font-semibold",
      running
        ? "bg-green-500/10 border-green-500/20 text-green-400"
        : "bg-white/5 border-white/10 text-white/30"
    )}>
      <div className={cn("w-1.5 h-1.5 rounded-full", running ? "bg-green-400 animate-pulse" : "bg-white/20")} />
      {running ? "ONLINE" : "OFFLINE"}
    </div>
  );
}

function StatCard({
  label, value, sub, icon: Icon, accent, subColor
}: {
  label: string; value: string; sub?: string; icon: any; accent?: string; subColor?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4 flex flex-col gap-3 hover:border-white/12 transition-all">
      <div className="flex items-center justify-between">
        <span className="text-white/40 text-xs font-medium uppercase tracking-wider">{label}</span>
        <div className={cn(
          "w-8 h-8 rounded-xl flex items-center justify-center",
          accent ?? "bg-violet-600/20"
        )}>
          <Icon className="w-4 h-4 text-violet-400" />
        </div>
      </div>
      <div>
        <p className="text-white font-bold text-xl font-mono">{value}</p>
        {sub && <p className={cn("text-xs mt-0.5 font-mono", subColor ?? "text-white/30")}>{sub}</p>}
      </div>
    </div>
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
      "text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wide",
      map[status] ?? "bg-white/5 border-white/10 text-white/40"
    )}>
      {status}
    </span>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

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
          return { ...old, recentTrades: old.recentTrades.map((t: Trade) => t.id === trade.id ? trade : t) };
        }
        return { ...old, recentTrades: [trade, ...old.recentTrades].slice(0, 50) };
      });
    });

    return () => { unsubStatus(); unsubTrade(); };
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
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-violet-400/60 font-mono text-sm animate-pulse">INITIALIZING TERMINAL...</div>
      </div>
    );
  }

  const { botStatus, stats, recentTrades } = data;
  const isPending = startBot.isPending || stopBot.isPending;
  const pnlValue = parseFloat(stats.totalPnlEth ?? "0");

  return (
    <div className="p-4 space-y-4 pb-8">

      {/* ── Bot control card ── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 rounded-xl bg-violet-500/20 blur-sm" />
              <div className="relative w-10 h-10 rounded-xl bg-gradient-to-br from-violet-600/30 to-indigo-700/30 border border-violet-500/20 flex items-center justify-center">
                <Crosshair className="w-5 h-5 text-violet-400" />
              </div>
            </div>
            <div>
              <p className="text-white font-bold text-sm">Command Center</p>
              <div className="flex items-center gap-2 mt-0.5">
                <StatusPill running={botStatus.running} />
                {botStatus.running && botStatus.uptimeSeconds != null && (
                  <span className="text-white/25 text-[10px] font-mono">{formatUptime(botStatus.uptimeSeconds)}</span>
                )}
              </div>
            </div>
          </div>

          <button
            onClick={handleTogglePower}
            disabled={isPending}
            className={cn(
              "h-11 px-5 rounded-2xl text-sm font-bold transition-all duration-200 flex items-center gap-2 active:scale-[0.97] disabled:opacity-60",
              botStatus.running
                ? "bg-white/[0.07] border border-white/15 text-white hover:bg-white/10"
                : "bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 text-white shadow-lg shadow-violet-500/20"
            )}
          >
            {isPending ? (
              <span className="font-mono tracking-widest text-xs">WAIT...</span>
            ) : botStatus.running ? (
              <><Square className="w-4 h-4" /> Stop</>
            ) : (
              <><Play className="w-4 h-4" /> Start</>
            )}
          </button>
        </div>

        {botStatus.errorMessage && (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-red-500/8 border border-red-500/15 px-3 py-2.5">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span className="text-red-300/80 text-xs font-mono">{botStatus.errorMessage}</span>
          </div>
        )}
      </div>

      {/* ── Wallet info ── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wallet className="w-3.5 h-3.5 text-violet-400/60" />
          <span className="text-white/40 text-xs">Wallet</span>
        </div>
        {botStatus.walletAddress ? (
          <div className="flex items-center gap-3">
            <span className="text-white font-mono text-sm font-semibold">
              {formatEth(botStatus.walletBalanceEth)} <span className="text-white/40 text-xs font-sans">ETH</span>
            </span>
            <div className="w-px h-4 bg-white/10" />
            <div className="flex items-center gap-1.5">
              <span className="text-white/50 text-xs font-mono">{formatAddress(botStatus.walletAddress)}</span>
              <a href={getBasescanAddressLink(botStatus.walletAddress)} target="_blank" rel="noreferrer">
                <ExternalLink className="w-3 h-3 text-violet-400/50 hover:text-violet-400 transition-colors" />
              </a>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-amber-400/80 text-xs font-mono">
            <AlertCircle className="w-3 h-3" /> KEY NOT SET
          </div>
        )}
      </div>

      {/* ── Stats grid ── */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Total Snipes"
          value={String(stats.totalTrades)}
          sub={stats.todayTrades != null ? `${stats.todayTrades} today` : undefined}
          icon={Hash}
        />
        <StatCard
          label="System Uptime"
          value={botStatus.running && botStatus.uptimeSeconds != null ? formatUptime(botStatus.uptimeSeconds) : "—"}
          sub={botStatus.lastEventAt ? `Last event: ${new Date(botStatus.lastEventAt).toLocaleTimeString()}` : undefined}
          icon={Clock}
          accent="bg-blue-500/20"
        />
        <StatCard
          label="Volume (ETH)"
          value={formatEth(stats.totalVolumeEth)}
          icon={BarChart3}
          accent="bg-indigo-500/20"
        />
        <StatCard
          label="Total PNL"
          value={(pnlValue >= 0 ? "+" : "") + formatEth(stats.totalPnlEth ?? "0")}
          sub={stats.winRatePercent != null ? `Win rate: ${stats.winRatePercent.toFixed(1)}%` : undefined}
          subColor={pnlValue > 0 ? "text-green-400/60" : pnlValue < 0 ? "text-red-400/60" : "text-white/30"}
          icon={pnlValue >= 0 ? TrendingUp : TrendingDown}
          accent={pnlValue >= 0 ? "bg-green-500/20" : "bg-red-500/20"}
        />
      </div>

      {/* ── Recent trades ── */}
      <div>
        <div className="flex items-center justify-between mb-3 px-1">
          <p className="text-white/60 text-xs font-semibold uppercase tracking-wider">Live Activity Feed</p>
          <span className="text-white/25 text-[10px] font-mono">{recentTrades.length} items</span>
        </div>

        {recentTrades.length === 0 ? (
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] py-10 flex flex-col items-center gap-2">
            <Crosshair className="w-8 h-8 text-white/10" />
            <p className="text-white/25 text-sm font-mono">NO RECENT ACTIVITY</p>
          </div>
        ) : (
          <div className="space-y-2">
            {recentTrades.slice(0, 20).map((trade) => (
              <div key={trade.id} className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3.5 flex items-center gap-3 hover:border-white/12 transition-all">
                {/* Status dot + avatar */}
                <div className="relative shrink-0">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-600/40 to-indigo-700/40 border border-violet-500/20 flex items-center justify-center">
                    <Zap className="w-4 h-4 text-violet-400" />
                  </div>
                  <div className={cn(
                    "absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#0d0d1a]",
                    trade.status === "confirmed" || trade.status === "sold" ? "bg-green-400" :
                    trade.status === "pending" ? "bg-amber-400 animate-pulse" : "bg-red-400"
                  )} />
                </div>

                {/* Token info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-semibold text-sm truncate">
                      {trade.tokenName || formatAddress(trade.tokenAddress)}
                    </span>
                    {trade.tokenSymbol && (
                      <span className="text-violet-400/70 text-xs font-mono shrink-0 bg-violet-500/10 px-1.5 py-0.5 rounded">
                        {trade.tokenSymbol}
                      </span>
                    )}
                    <TradePill status={trade.status} />
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Clock className="w-3 h-3 text-white/20" />
                    <span className="text-white/30 text-[11px]">
                      {new Date(trade.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="text-white/15">·</span>
                    <span className="text-white/25 text-[11px] font-mono">
                      Creator: {formatAddress(trade.creatorAddress)}
                    </span>
                  </div>
                </div>

                {/* Right side */}
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="text-white font-mono text-sm font-semibold">
                    {formatEth(trade.buyAmountEth)} ETH
                  </span>
                  {trade.status === "sold" && trade.pnlEth && (
                    <span className={cn(
                      "text-xs font-mono",
                      parseFloat(trade.pnlEth) > 0 ? "text-green-400" : "text-red-400"
                    )}>
                      {parseFloat(trade.pnlEth) > 0 ? "+" : ""}{formatEth(trade.pnlEth)} ETH
                    </span>
                  )}
                  {trade.txHash && (
                    <a href={getBasescanTxLink(trade.txHash)} target="_blank" rel="noreferrer">
                      <ExternalLink className="w-3 h-3 text-violet-400/40 hover:text-violet-400 transition-colors" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
