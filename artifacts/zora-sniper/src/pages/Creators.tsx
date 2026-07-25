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
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Trash2, UserPlus, ExternalLink, SlidersHorizontal, Globe } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatAddress, getBasescanAddressLink } from "@/lib/utils";

// ── Per-wallet settings sheet ──────────────────────────────────────────────

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
    setAutoSellMode("global");
    setTakeProfit("");
    setStopLoss("");
  };

  return (
    <SheetContent className="w-full sm:max-w-md overflow-y-auto">
      <SheetHeader className="mb-6">
        <SheetTitle className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-blue-500" />
          Per-Wallet Settings
        </SheetTitle>
        <SheetDescription>
          <span className="font-medium text-foreground">
            {creator.label || "Unnamed"}
          </span>{" "}
          —{" "}
          <span className="font-mono text-xs">{formatAddress(creator.address)}</span>
          <br />
          Leave fields empty to use the global configuration.
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-6">
        {/* Execution overrides */}
        <div>
          <p className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            Execution Overrides
          </p>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Buy Amount (ETH)</label>
              <div className="relative">
                <Input
                  placeholder="e.g. 0.005  (empty = global)"
                  value={buyAmount}
                  onChange={(e) => setBuyAmount(e.target.value)}
                  className="font-mono bg-background pr-10"
                />
                {buyAmount && (
                  <Globe className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-blue-400" />
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Max Slippage (%)</label>
              <Input
                type="number"
                step="0.1"
                placeholder="e.g. 3  (empty = global)"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                className="font-mono bg-background"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Max Gas Price (Gwei)</label>
              <Input
                type="number"
                placeholder="e.g. 30  (empty = global)"
                value={maxGas}
                onChange={(e) => setMaxGas(e.target.value)}
                className="font-mono bg-background"
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Risk management overrides */}
        <div>
          <p className="text-sm font-semibold mb-3">Risk Management</p>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Auto-Sell</label>
              <Select
                value={autoSellMode}
                onValueChange={(v) => setAutoSellMode(v as "global" | "on" | "off")}
              >
                <SelectTrigger className="bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Enabled for this wallet</SelectItem>
                  <SelectItem value="off">Disabled for this wallet</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {autoSellMode === "on" && (
              <div className="grid grid-cols-2 gap-3 pl-3 border-l-2 border-muted">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Take Profit (%)</label>
                  <Input
                    type="number"
                    placeholder="Optional"
                    value={takeProfit}
                    onChange={(e) => setTakeProfit(e.target.value)}
                    className="font-mono bg-background text-green-600 font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Stop Loss (%)</label>
                  <Input
                    type="number"
                    placeholder="Optional"
                    value={stopLoss}
                    onChange={(e) => setStopLoss(e.target.value)}
                    className="font-mono bg-background text-red-600 font-bold"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <Separator />

        <div className="flex gap-3 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            className="flex-none"
          >
            Reset to Global
          </Button>
          <Button
            className="flex-1"
            onClick={handleSave}
            disabled={updateCreator.isPending}
          >
            {updateCreator.isPending ? "Saving..." : "Save Settings"}
          </Button>
        </div>
      </div>
    </SheetContent>
  );
}

// ── Main Creators page ─────────────────────────────────────────────────────

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

  /** Returns true if the creator has any per-wallet overrides configured */
  const hasCustomSettings = (c: Creator) =>
    c.buyAmountEth != null ||
    c.slippagePercent != null ||
    c.maxGasGwei != null ||
    c.autoSell != null;

  return (
    <div className="p-8 space-y-8 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Creator Whitelist</h1>
        <p className="text-muted-foreground mt-2">
          Manage wallet addresses to snipe. Each wallet can override global sniper settings individually.
        </p>
      </div>

      <Card className="border-border">
        <CardHeader className="bg-muted/30 border-b">
          <CardTitle className="text-lg flex items-center gap-2">
            <UserPlus className="h-5 w-5" /> Add New Target
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <form onSubmit={handleAdd} className="flex gap-4 items-end">
            <div className="flex-1 space-y-2">
              <label className="text-sm font-medium">Wallet Address (0x...)</label>
              <Input 
                placeholder="0x1234..." 
                value={newAddress} 
                onChange={(e) => setNewAddress(e.target.value)} 
                className="font-mono bg-background"
                required
              />
            </div>
            <div className="flex-1 space-y-2">
              <label className="text-sm font-medium">Label / Name</label>
              <Input 
                placeholder="e.g. Zora Power User" 
                value={newLabel} 
                onChange={(e) => setNewLabel(e.target.value)} 
                className="bg-background"
              />
            </div>
            <Button type="submit" disabled={addCreator.isPending} className="w-32">
              {addCreator.isPending ? "Adding..." : "Add to List"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <div className="rounded-md border">
          <Table>
            <TableHeader className="bg-muted/20">
              <TableRow>
                <TableHead>Target</TableHead>
                <TableHead>Address</TableHead>
                <TableHead className="text-right">Snipes</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">Loading targets...</TableCell>
                </TableRow>
              ) : creators.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center h-32 text-muted-foreground">
                    No creators in watchlist. Add one above.
                  </TableCell>
                </TableRow>
              ) : (
                creators.map((c) => (
                  <TableRow key={c.address}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {c.label || <span className="text-muted-foreground italic">Unnamed</span>}
                        {hasCustomSettings(c) && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-blue-500/50 text-blue-400">
                            custom
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{formatAddress(c.address)}</span>
                        <a href={getBasescanAddressLink(c.address)} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono">{c.totalSniped}</TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <Switch 
                          checked={c.enabled} 
                          onCheckedChange={(checked) => handleToggle(c.address, checked)}
                          disabled={updateCreator.isPending}
                        />
                        {c.enabled ? (
                          <Badge variant="success" className="text-[10px] w-14 justify-center">ACTIVE</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px] w-14 justify-center">PAUSED</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-blue-500 hover:bg-blue-500/10"
                          onClick={() => setSettingsTarget(c)}
                          title="Per-wallet settings"
                        >
                          <SlidersHorizontal className="h-4 w-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleRemove(c.address)}
                          disabled={removeCreator.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

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
