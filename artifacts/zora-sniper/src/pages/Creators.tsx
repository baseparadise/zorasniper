import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCreators,
  useAddCreator,
  useRemoveCreator,
  useUpdateCreator,
  getListCreatorsQueryKey
} from "@workspace/api-client-react";
import type { Creator } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Trash2, UserPlus, ExternalLink, SlidersHorizontal, Globe, Users, Check, RotateCcw, TrendingUp, TrendingDown, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatAddress, getBasescanAddressLink, cn } from "@/lib/utils";

// ── Per-wallet settings sheet ────────────────────────────────────────────────

interface WalletSettingsSheetProps {
  creator: Creator | null;
  onClose: () => void;
}

function WalletSettingsSheet({ creator, onClose }: WalletSettingsSheetProps) {
  const updateCreator = useUpdateCreator();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [buyAmount, setBuyAmount] = useState<string>(creator?.buyAmountEth ?? "");
  const [slippage, setSlippage] = useState<string>(
    creator?.slippagePercent != null ? String(creator.slippagePercent) : ""
  );
  const [maxGas, setMaxGas] = useState<string>(
    creator?.maxGasGwei != null ? String(creator.maxGasGwei) : ""
  );
  const [maxBuysPerDay, setMaxBuysPerDay] = useState<string>(
    creator?.maxBuysPerDay != null ? String(creator.maxBuysPerDay) : ""
  );
  const [autoSellMode, setAutoSellMode] = useState<"global" | "on" | "off">(
    creator?.autoSell === true ? "on" : creator?.autoSell === false ? "off" : "global"
  );
  const [takeProfit, setTakeProfit] = useState<string>(
    creator?.takeProfitPercent != null ? String(creator.takeProfitPercent) : ""
  );
  const [stopLoss, setStopLoss] = useState<string>(
    creator?.stopLossPercent != null ? String(creator.stopLossPercent) : ""
  );

  if (!creator) return null;

  const handleSave = () => {
    const autoSellValue =
      autoSellMode === "on" ? true : autoSellMode === "off" ? false : null;

    updateCreator.mutate(
      {
        address: creator.address,
        data: {
          buyAmountEth: buyAmount.trim() !== "" ? buyAmount.trim() : null,
          slippagePercent: slippage.trim() !== "" ? parseFloat(slippage) : null,
          maxGasGwei: maxGas.trim() !== "" ? parseFloat(maxGas) : null,
          maxBuysPerDay: maxBuysPerDay.trim() !== "" ? parseInt(maxBuysPerDay, 10) : null,
          autoSell: autoSellValue,
          takeProfitPercent:
            autoSellMode === "on" && takeProfit.trim() !== ""
              ? parseFloat(takeProfit)
              : null,
          stopLossPercent:
            autoSellMode === "on" && stopLoss.trim() !== ""
              ? parseFloat(stopLoss)
              : null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCreatorsQueryKey() });
          toast({
            title: "Settings Saved",
            description: `Per-wallet settings updated for ${creator.label || formatAddress(creator.address)}.`,
          });
          onClose();
        },
        onError: () =>
          toast({
            variant: "destructive",
            title: "Error",
            description: "Failed to save per-wallet settings.",
          }),
      }
    );
  };

  const handleReset = () => {
    setBuyAmount("");
    setSlippage("");
    setMaxGas("");
    setMaxBuysPerDay("");
    setAutoSellMode("global");
    setTakeProfit("");
    setStopLoss("");
  };

  const inputClass = "bg-white/[0.07] border border-white/15 rounded-xl text-white placeholder-white/20 text-sm focus-visible:ring-violet-500/40 focus-visible:border-violet-400/50 h-11 font-mono";
  const labelClass = "text-white/50 text-xs font-semibold uppercase tracking-wider mb-2 block";

  return (
    <SheetContent className="w-full sm:max-w-md overflow-y-auto bg-[#0d0d1a] border-white/10 text-white">
      <SheetHeader className="mb-6">
        <SheetTitle className="text-white font-bold flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-violet-400" />
          Per-Wallet Settings
        </SheetTitle>
        <SheetDescription className="text-white/40 text-sm">
          <span className="font-medium text-white/70">
            {creator.label || "Unnamed"}
          </span>{" "}
          —{" "}
          <span className="font-mono text-xs text-violet-300/60">{formatAddress(creator.address)}</span>
          <br />
          Leave fields empty to use the global configuration.
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-6">
        {/* ── Execution overrides ── */}
        <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4 space-y-4">
          <p className="text-white/60 text-xs font-semibold uppercase tracking-wider">Execution Overrides</p>

          <div>
            <label className={labelClass}>Buy Amount (ETH)</label>
            <div className="relative">
              <Input
                placeholder="e.g. 0.005  (empty = global)"
                value={buyAmount}
                onChange={(e) => setBuyAmount(e.target.value)}
                className={inputClass}
              />
              {buyAmount && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-violet-400" />
              )}
            </div>
          </div>

          <div>
            <label className={labelClass}>Max Slippage (%)</label>
            <Input
              type="number"
              step="0.1"
              placeholder="e.g. 3  (empty = global)"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label className={labelClass}>Max Gas Price (Gwei)</label>
            <Input
              type="number"
              placeholder="e.g. 30  (empty = global)"
              value={maxGas}
              onChange={(e) => setMaxGas(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label className={labelClass}>Max Buys Per Day</label>
            <Input
              type="number"
              min="1"
              step="1"
              placeholder="e.g. 3  (empty = global)"
              value={maxBuysPerDay}
              onChange={(e) => setMaxBuysPerDay(e.target.value)}
              className={inputClass}
            />
            <p className="text-white/25 text-xs mt-1.5">
              Stop sniping this wallet once this many buys are recorded today.
            </p>
          </div>
        </div>

        {/* ── Risk management ── */}
        <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4 space-y-4">
          <p className="text-white/60 text-xs font-semibold uppercase tracking-wider">Risk Management</p>

          <div>
            <label className={labelClass}>Auto-Sell</label>
            <Select
              value={autoSellMode}
              onValueChange={(v) => setAutoSellMode(v as "global" | "on" | "off")}
            >
              <SelectTrigger className="h-11 rounded-xl bg-white/[0.07] border-white/15 text-white text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#0d0d1a] border-white/10 text-white rounded-xl">
                <SelectItem value="global">Use Global Setting</SelectItem>
                <SelectItem value="on">Enabled for this wallet</SelectItem>
                <SelectItem value="off">Disabled for this wallet</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {autoSellMode === "on" && (
            <div className="grid grid-cols-2 gap-3 pl-3 border-l-2 border-violet-500/30">
              <div>
                <label className={labelClass}>Take Profit (%)</label>
                <Input
                  type="number"
                  placeholder="Optional"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  className={cn(inputClass, "text-green-400")}
                />
              </div>
              <div>
                <label className={labelClass}>Stop Loss (%)</label>
                <Input
                  type="number"
                  placeholder="Optional"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  className={cn(inputClass, "text-red-400")}
                />
              </div>
            </div>
          )}
        </div>

        {/* ── Actions ── */}
        <div className="flex gap-3">
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/50 text-sm font-semibold hover:bg-white/8 hover:text-white/70 transition-all"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset to Global
          </button>
          <button
            onClick={handleSave}
            disabled={updateCreator.isPending}
            className="flex-1 h-11 rounded-2xl bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 text-white font-bold text-sm transition-all shadow-lg shadow-violet-500/20 flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-50"
          >
            <Check className="w-4 h-4" />
            {updateCreator.isPending ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </div>
    </SheetContent>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true if the creator has any per-wallet overrides configured */
function hasCustomSettings(c: Creator) {
  return (
    c.buyAmountEth != null ||
    c.slippagePercent != null ||
    c.maxGasGwei != null ||
    c.autoSell != null ||
    c.maxBuysPerDay != null
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function Creators() {
  const { data: creators = [], isLoading } = useListCreators();
  const addCreator = useAddCreator();
  const removeCreator = useRemoveCreator();
  const updateCreator = useUpdateCreator();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [settingsTarget, setSettingsTarget] = useState<Creator | null>(null);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAddress || !newAddress.startsWith("0x") || newAddress.length !== 42) {
      toast({ variant: "destructive", title: "Invalid Address", description: "Must be a valid Ethereum address." });
      return;
    }
    addCreator.mutate(
      { data: { address: newAddress.toLowerCase(), label: newLabel } },
      {
        onSuccess: () => {
          setNewAddress("");
          setNewLabel("");
          toast({ title: "Creator Added", description: "Successfully added to watchlist." });
          queryClient.invalidateQueries({ queryKey: getListCreatorsQueryKey() });
        },
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to add creator." })
      }
    );
  };

  const handleToggle = (address: string, enabled: boolean) => {
    updateCreator.mutate(
      { address, data: { enabled } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCreatorsQueryKey() });
        },
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to update status." })
      }
    );
  };

  const handleRemove = (address: string) => {
    if (!confirm("Are you sure you want to remove this creator?")) return;
    removeCreator.mutate(
      { address },
      {
        onSuccess: () => {
          toast({ title: "Creator Removed", description: "Removed from watchlist." });
          queryClient.invalidateQueries({ queryKey: getListCreatorsQueryKey() });
        },
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to remove creator." })
      }
    );
  };

  const inputClass = "bg-white/[0.07] border border-white/15 rounded-xl text-white placeholder-white/20 text-sm focus-visible:ring-violet-500/40 focus-visible:border-violet-400/50 h-11";

  return (
    <div className="p-4 space-y-4 pb-8">

      {/* ── Header ── */}
      <div>
        <h2 className="text-white font-bold text-lg">Creator Whitelist</h2>
        <p className="text-white/30 text-xs mt-0.5">Manage wallets to snipe. Each wallet can override global settings individually.</p>
      </div>

      {/* ── Add creator card ── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
        <p className="text-white/50 text-xs font-semibold uppercase tracking-wider mb-3">Add New Target</p>
        <form onSubmit={handleAdd} className="space-y-3">
          <Input
            value={newAddress}
            onChange={(e) => setNewAddress(e.target.value)}
            placeholder="Wallet address (0x...)"
            className={cn(inputClass, "font-mono")}
            required
          />
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label / Name (optional)"
            className={inputClass}
          />
          <button
            type="submit"
            disabled={addCreator.isPending}
            className="w-full h-11 rounded-2xl bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 text-white font-bold text-sm transition-all shadow-lg shadow-violet-500/20 flex items-center justify-center gap-2 active:scale-[0.98] disabled:bg-white/[0.06] disabled:text-white/20 disabled:shadow-none disabled:cursor-not-allowed"
          >
            <UserPlus className="w-4 h-4" />
            {addCreator.isPending ? "Adding..." : "Add to List"}
          </button>
        </form>
      </div>

      {/* ── Creator cards ── */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-white/8 bg-white/[0.04] h-24 animate-pulse" />
          ))}
        </div>
      ) : creators.length === 0 ? (
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] py-16 flex flex-col items-center gap-3">
          <Users className="w-10 h-10 text-white/10" />
          <p className="text-white/25 text-sm">No creators in watchlist. Add one above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {creators.map((c) => (
            <div key={c.address} className={cn(
              "rounded-2xl border bg-white/[0.04] overflow-hidden hover:border-white/12 transition-all",
              c.enabled ? "border-white/8" : "border-white/5 opacity-60"
            )}>
              {/* ── Main row ── */}
              <div className="flex items-center gap-3 px-4 py-3.5">
                {/* Avatar */}
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-700 flex items-center justify-center shrink-0 shadow-md shadow-violet-500/20">
                  <span className="text-white font-bold text-xs">
                    {(c.label || c.address).slice(0, 2).toUpperCase()}
                  </span>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-white font-semibold text-sm truncate">
                      {c.label || <span className="text-white/40 italic">Unnamed</span>}
                    </p>
                    <span className={cn(
                      "text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0",
                      c.enabled
                        ? "bg-green-500/10 border-green-500/20 text-green-400"
                        : "bg-white/5 border-white/10 text-white/30"
                    )}>
                      {c.enabled ? "ACTIVE" : "PAUSED"}
                    </span>
                    {hasCustomSettings(c) && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 bg-violet-500/10 border-violet-500/20 text-violet-400">
                        custom
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-white/30 text-[11px] font-mono">{formatAddress(c.address)}</span>
                    {c.buyAmountEth && (
                      <>
                        <span className="text-white/15">·</span>
                        <span className="text-violet-300/50 text-[11px] font-mono">{c.buyAmountEth} ETH</span>
                      </>
                    )}
                    {c.maxBuysPerDay != null && (
                      <>
                        <span className="text-white/15">·</span>
                        <span className="text-amber-300/50 text-[11px] font-mono">{c.maxBuysPerDay}/day</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Snipe count + toggle */}
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <div className="flex items-center gap-1.5">
                    <Zap className="w-3 h-3 text-violet-400/50" />
                    <span className="text-white/40 text-xs font-mono">{c.totalSniped}</span>
                  </div>
                  <Switch
                    checked={c.enabled}
                    onCheckedChange={(checked) => handleToggle(c.address, checked)}
                    disabled={updateCreator.isPending}
                    className="data-[state=checked]:bg-violet-600 scale-90"
                  />
                </div>
              </div>

              {/* ── Action row ── */}
              <div className="flex items-center gap-2 px-4 py-2.5 border-t border-white/5 bg-black/20">
                <a
                  href={getBasescanAddressLink(c.address)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-white/25 hover:text-violet-300 text-[11px] font-mono transition-colors"
                >
                  <Globe className="w-3 h-3" />
                  Basescan
                </a>
                {c.zoraProfileUrl && (
                  <a
                    href={c.zoraProfileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-white/25 hover:text-violet-300 text-[11px] font-mono transition-colors ml-2"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Zora
                  </a>
                )}

                <div className="flex-1" />

                <button
                  onClick={() => setSettingsTarget(c)}
                  className="w-7 h-7 rounded-lg border border-white/10 bg-white/5 hover:bg-violet-500/10 hover:border-violet-500/20 flex items-center justify-center text-white/30 hover:text-violet-400 transition-all"
                  title="Per-wallet settings"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                </button>

                <button
                  onClick={() => handleRemove(c.address)}
                  disabled={removeCreator.isPending}
                  className="w-7 h-7 rounded-lg border border-white/10 bg-white/5 hover:bg-red-500/10 hover:border-red-500/20 flex items-center justify-center text-white/30 hover:text-red-400 transition-all disabled:opacity-30"
                  title="Remove creator"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Per-wallet settings sheet */}
      <Sheet open={!!settingsTarget} onOpenChange={(open) => { if (!open) setSettingsTarget(null); }}>
        <WalletSettingsSheet
          creator={settingsTarget}
          onClose={() => setSettingsTarget(null)}
        />
      </Sheet>
    </div>
  );
}
