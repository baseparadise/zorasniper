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
import { Trash2, UserPlus, ExternalLink, SlidersHorizontal, Globe, Users, Zap, Check } from "lucide-react";
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

  if (!creator) return null;

  const handleSave = () => {
    updateCreator.mutate(
      {
        address: creator.address,
        data: {
          buyAmountEth: buyAmount || undefined,
          slippagePercent: slippage ? Number(slippage) : undefined,
          maxGasGwei: maxGas ? Number(maxGas) : undefined,
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCreatorsQueryKey() });
          toast({ title: "Settings saved", description: `Updated settings for ${formatAddress(creator.address)}` });
          onClose();
        },
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to save settings." })
      }
    );
  };

  const inputClass = "bg-white/[0.07] border border-white/15 rounded-xl text-white placeholder-white/20 text-sm focus:ring-violet-500/40 focus:border-violet-400/50 h-11";

  return (
    <SheetContent className="bg-[#0d0d1a] border-white/10 text-white">
      <SheetHeader className="mb-6">
        <SheetTitle className="text-white font-bold">Per-Wallet Settings</SheetTitle>
        <SheetDescription className="text-white/40 text-sm">
          Overrides for <span className="font-mono text-violet-300/70">{formatAddress(creator.address)}</span>
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-4">
        <div>
          <label className="text-white/50 text-xs font-semibold uppercase tracking-wider mb-2 block">Buy Amount (ETH)</label>
          <Input
            value={buyAmount}
            onChange={(e) => setBuyAmount(e.target.value)}
            placeholder="Use global default"
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-white/50 text-xs font-semibold uppercase tracking-wider mb-2 block">Slippage (%)</label>
          <Input
            value={slippage}
            onChange={(e) => setSlippage(e.target.value)}
            type="number"
            placeholder="Use global default"
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-white/50 text-xs font-semibold uppercase tracking-wider mb-2 block">Max Gas (Gwei)</label>
          <Input
            value={maxGas}
            onChange={(e) => setMaxGas(e.target.value)}
            type="number"
            placeholder="Use global default"
            className={inputClass}
          />
        </div>

        <Separator className="border-white/8" />

        <button
          onClick={handleSave}
          disabled={updateCreator.isPending}
          className="w-full h-11 rounded-2xl bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 text-white font-bold text-sm transition-all shadow-lg shadow-violet-500/20 flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-50"
        >
          <Check className="w-4 h-4" />
          {updateCreator.isPending ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </SheetContent>
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

  const handleAdd = () => {
    if (!newAddress.trim()) return;
    addCreator.mutate(
      { data: { address: newAddress.trim(), label: newLabel.trim() || undefined } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCreatorsQueryKey() });
          setNewAddress("");
          setNewLabel("");
          toast({ title: "Creator added", description: "Now watching this wallet." });
        },
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to add creator." })
      }
    );
  };

  const handleRemove = (address: string) => {
    removeCreator.mutate(
      { address },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCreatorsQueryKey() });
          toast({ title: "Creator removed" });
        },
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to remove." })
      }
    );
  };

  const handleToggle = (c: Creator) => {
    updateCreator.mutate(
      { address: c.address, data: { enabled: !c.enabled } },
      {
        onSuccess: () => queryClient.invalidateQueries({ queryKey: getListCreatorsQueryKey() }),
        onError: () => toast({ variant: "destructive", title: "Error", description: "Failed to update." })
      }
    );
  };

  const inputClass = "bg-white/[0.07] border border-white/15 rounded-xl text-white placeholder-white/20 text-sm focus:ring-violet-500/40 focus:border-violet-400/50 h-11";

  return (
    <div className="p-4 space-y-4 pb-8">

      {/* ── Header ── */}
      <div>
        <h2 className="text-white font-bold text-lg">Watched Creators</h2>
        <p className="text-white/30 text-xs mt-0.5">Wallets to snipe tokens from</p>
      </div>

      {/* ── Add creator card ── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4 space-y-3">
        <p className="text-white/50 text-xs font-semibold uppercase tracking-wider">Add Creator</p>
        <Input
          value={newAddress}
          onChange={(e) => setNewAddress(e.target.value)}
          placeholder="Wallet address (0x...)"
          className={inputClass}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <Input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label (optional)"
          className={inputClass}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button
          onClick={handleAdd}
          disabled={!newAddress.trim() || addCreator.isPending}
          className="w-full h-11 rounded-2xl bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 text-white font-bold text-sm transition-all shadow-lg shadow-violet-500/20 flex items-center justify-center gap-2 active:scale-[0.98] disabled:bg-white/[0.06] disabled:text-white/20 disabled:shadow-none disabled:cursor-not-allowed"
        >
          <UserPlus className="w-4 h-4" />
          {addCreator.isPending ? "Adding..." : "Add Creator"}
        </button>
      </div>

      {/* ── Creator cards ── */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-white/8 bg-white/[0.04] h-20 animate-pulse" />
          ))}
        </div>
      ) : creators.length === 0 ? (
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] py-16 flex flex-col items-center gap-3">
          <Users className="w-10 h-10 text-white/10" />
          <p className="text-white/25 text-sm">No creators added yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {creators.map((c) => (
            <div key={c.id} className={cn(
              "rounded-2xl border bg-white/[0.04] overflow-hidden hover:border-white/12 transition-all",
              c.enabled ? "border-white/8" : "border-white/5 opacity-60"
            )}>
              <div className="flex items-center gap-3 px-4 py-3.5">
                {/* Avatar */}
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-700 flex items-center justify-center shrink-0 shadow-md shadow-violet-500/20">
                  <span className="text-white font-bold text-xs">
                    {(c.label ?? c.address).slice(0, 2).toUpperCase()}
                  </span>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-white font-semibold text-sm truncate">
                      {c.label ?? formatAddress(c.address)}
                    </p>
                    <span className={cn(
                      "text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0",
                      c.enabled
                        ? "bg-green-500/10 border-green-500/20 text-green-400"
                        : "bg-white/5 border-white/10 text-white/30"
                    )}>
                      {c.enabled ? "ACTIVE" : "PAUSED"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-white/30 text-[11px] font-mono">{formatAddress(c.address)}</span>
                    {c.buyAmountEth && (
                      <>
                        <span className="text-white/15">·</span>
                        <span className="text-violet-300/50 text-[11px] font-mono">{c.buyAmountEth} ETH</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Controls */}
                <div className="flex items-center gap-2 shrink-0">
                  <Switch
                    checked={c.enabled}
                    onCheckedChange={() => handleToggle(c)}
                    className="data-[state=checked]:bg-violet-600"
                  />
                </div>
              </div>

              {/* Action row */}
              <div className="flex items-center gap-2 px-4 py-2.5 border-t border-white/5 bg-black/20">
                <a
                  href={getBasescanAddressLink(c.address)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-white/30 hover:text-violet-300 text-[11px] font-mono transition-colors"
                >
                  <Globe className="w-3 h-3" />
                  Basescan
                </a>

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
