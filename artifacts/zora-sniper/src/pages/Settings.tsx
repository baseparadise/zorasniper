import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetConfig,
  useUpdateConfig,
  getGetConfigQueryKey
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Save, ShieldAlert, Zap, TrendingUp, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

const configSchema = z.object({
  buyAmountEth: z.string().min(1, "Required").regex(/^\d*\.?\d+$/, "Must be a valid number"),
  slippagePercent: z.coerce.number().min(0).max(100),
  maxGasGwei: z.coerce.number().min(0),
  watchMode: z.enum(["whitelist", "all"]),
  enabled: z.boolean(),
  minLiquidityEth: z.coerce.number().nullable().optional(),
  autoSell: z.boolean().default(false),
  takeProfitPercent: z.coerce.number().nullable().optional(),
  stopLossPercent: z.coerce.number().nullable().optional(),
  maxBuysPerDay: z.coerce.number().int().positive().nullable().optional(),
});

type ConfigFormValues = z.infer<typeof configSchema>;

function SectionHeader({ icon: Icon, title, desc }: { icon: any; title: string; desc?: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="w-9 h-9 rounded-xl bg-violet-600/20 border border-violet-500/20 flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-violet-400" />
      </div>
      <div>
        <p className="text-white font-semibold text-sm">{title}</p>
        {desc && <p className="text-white/35 text-xs mt-0.5">{desc}</p>}
      </div>
    </div>
  );
}

function FieldRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-white/80 text-sm font-medium">{label}</p>
        {desc && <p className="text-white/30 text-xs mt-0.5">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const inputClass = "bg-white/[0.07] border border-white/15 rounded-xl text-white placeholder-white/20 text-sm h-10 w-36 focus:ring-violet-500/40 focus:border-violet-400/50 font-mono";

export default function Settings() {
  const { data: config, isLoading } = useGetConfig();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<ConfigFormValues>({
    resolver: zodResolver(configSchema),
    defaultValues: {
      buyAmountEth: "0.01",
      slippagePercent: 10,
      maxGasGwei: 5,
      watchMode: "whitelist",
      enabled: false,
      minLiquidityEth: null,
      autoSell: false,
      takeProfitPercent: null,
      stopLossPercent: null,
      maxBuysPerDay: null,
    }
  });

  useEffect(() => {
    if (config) {
      form.reset({
        buyAmountEth: config.buyAmountEth,
        slippagePercent: config.slippagePercent,
        maxGasGwei: config.maxGasGwei,
        watchMode: config.watchMode as "whitelist" | "all",
        enabled: config.enabled,
        minLiquidityEth: config.minLiquidityEth,
        autoSell: config.autoSell ?? false,
        takeProfitPercent: config.takeProfitPercent,
        stopLossPercent: config.stopLossPercent,
        maxBuysPerDay: config.maxBuysPerDay ?? null,
      });
    }
  }, [config, form]);

  const onSubmit = (data: ConfigFormValues) => {
    updateConfig.mutate(
      { data },
      {
        onSuccess: (updated) => {
          queryClient.setQueryData(getGetConfigQueryKey(), updated);
          toast({ title: "Configuration Saved", description: "Sniper settings updated." });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Save Failed", description: "Could not save configuration." });
        }
      }
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-violet-400/60 font-mono text-sm animate-pulse">LOADING CONFIGURATION...</div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 pb-8">
      {/* ── Header ── */}
      <div>
        <h2 className="text-white font-bold text-lg">System Configuration</h2>
        <p className="text-white/30 text-xs mt-0.5">Core bot parameters and risk management</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">

          {/* ── Bot Control ── */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
            <SectionHeader icon={Zap} title="Bot Control" desc="Master switch and watch mode" />
            <div className="space-y-0 divide-y divide-white/5">

              <FormField
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <FieldRow label="Bot Enabled" desc="Master on/off switch">
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        className="data-[state=checked]:bg-violet-600"
                      />
                    </FormControl>
                  </FieldRow>
                )}
              />

              <FormField
                control={form.control}
                name="watchMode"
                render={({ field }) => (
                  <FieldRow label="Watch Mode" desc="Whitelist = only watched creators">
                    <FormControl>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="w-36 h-10 rounded-xl bg-white/[0.07] border-white/15 text-white text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#0d0d1a] border-white/10 text-white rounded-xl">
                          <SelectItem value="whitelist">Whitelist</SelectItem>
                          <SelectItem value="all">All Creators</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                  </FieldRow>
                )}
              />
            </div>
          </div>

          {/* ── Execution ── */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
            <SectionHeader icon={Settings2} title="Execution" desc="Trade sizing and gas parameters" />
            <div className="space-y-0 divide-y divide-white/5">

              <FormField
                control={form.control}
                name="buyAmountEth"
                render={({ field }) => (
                  <FieldRow label="Buy Amount (ETH)" desc="Per-snipe spend">
                    <FormControl>
                      <Input {...field} type="text" className={inputClass} placeholder="0.01" />
                    </FormControl>
                  </FieldRow>
                )}
              />

              <FormField
                control={form.control}
                name="slippagePercent"
                render={({ field }) => (
                  <FieldRow label="Slippage (%)" desc="Max allowed slippage">
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        className={inputClass}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                  </FieldRow>
                )}
              />

              <FormField
                control={form.control}
                name="maxGasGwei"
                render={({ field }) => (
                  <FieldRow label="Max Gas (Gwei)" desc="Gas price ceiling">
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        className={inputClass}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                  </FieldRow>
                )}
              />

              <FormField
                control={form.control}
                name="minLiquidityEth"
                render={({ field }) => (
                  <FieldRow label="Min Liquidity (ETH)" desc="Skip tokens below this">
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value || ""}
                        onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : null)}
                        type="number"
                        className={inputClass}
                        placeholder="Optional"
                      />
                    </FormControl>
                  </FieldRow>
                )}
              />

              <FormField
                control={form.control}
                name="maxBuysPerDay"
                render={({ field }) => (
                  <FieldRow label="Max Buys/Day" desc="Daily trade limit">
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value || ""}
                        onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : null)}
                        type="number"
                        className={inputClass}
                        placeholder="Unlimited"
                      />
                    </FormControl>
                  </FieldRow>
                )}
              />
            </div>
          </div>

          {/* ── Risk Management ── */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4">
            <SectionHeader icon={ShieldAlert} title="Risk Management" desc="Auto-sell and profit targets" />
            <div className="space-y-0 divide-y divide-white/5">

              <FormField
                control={form.control}
                name="autoSell"
                render={({ field }) => (
                  <FieldRow label="Auto Sell" desc="Automatically sell on target/stop">
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        className="data-[state=checked]:bg-violet-600"
                      />
                    </FormControl>
                  </FieldRow>
                )}
              />

              <FormField
                control={form.control}
                name="takeProfitPercent"
                render={({ field }) => (
                  <FieldRow label="Take Profit (%)" desc="Sell at this gain">
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value || ""}
                        onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : null)}
                        type="number"
                        className={cn(inputClass, "text-green-400")}
                        placeholder="Optional"
                      />
                    </FormControl>
                  </FieldRow>
                )}
              />

              <FormField
                control={form.control}
                name="stopLossPercent"
                render={({ field }) => (
                  <FieldRow label="Stop Loss (%)" desc="Sell at this loss">
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value || ""}
                        onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : null)}
                        type="number"
                        className={cn(inputClass, "text-red-400")}
                        placeholder="Optional"
                      />
                    </FormControl>
                  </FieldRow>
                )}
              />
            </div>
          </div>

          {/* ── Save button ── */}
          <button
            type="submit"
            disabled={updateConfig.isPending}
            className="w-full h-13 rounded-2xl bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 text-white font-bold text-sm transition-all shadow-lg shadow-violet-500/20 flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="w-4 h-4" />
            {updateConfig.isPending ? "Saving..." : "Save Settings"}
          </button>
        </form>
      </Form>
    </div>
  );
}
