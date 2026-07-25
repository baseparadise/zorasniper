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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { Save, ShieldAlert, Zap } from "lucide-react";

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
          toast({ title: "Configuration Saved", description: "Sniper settings have been updated successfully." });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Save Failed", description: "Could not save configuration." });
        }
      }
    );
  };

  if (isLoading) {
    return <div className="p-8 font-mono animate-pulse">LOADING CONFIGURATION...</div>;
  }

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">System Configuration</h1>
        <p className="text-muted-foreground mt-2">Adjust core bot parameters, execution limits, and risk management.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Card className="border-border">
            <CardHeader className="bg-muted/30 border-b pb-4">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Zap className="h-5 w-5 text-blue-500" /> Execution Parameters
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
              <FormField
                control={form.control}
                name="buyAmountEth"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Buy Amount (ETH)</FormLabel>
                    <FormControl>
                      <Input {...field} className="font-mono bg-background" />
                    </FormControl>
                    <FormDescription>Amount to spend per snipe.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="slippagePercent"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max Slippage (%)</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" step="0.1" className="font-mono bg-background" />
                    </FormControl>
                    <FormDescription>Tolerance for price movement.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="maxGasGwei"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max Gas Price (Gwei)</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" className="font-mono bg-background" />
                    </FormControl>
                    <FormDescription>Absolute ceiling for network fees.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="watchMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Target Mode</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger className="bg-background">
                          <SelectValue placeholder="Select mode" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="whitelist">Whitelist Only</SelectItem>
                        <SelectItem value="all">Global (All New Mints)</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>Restrict to specific creators or watch all.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="maxBuysPerDay"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max Buys Per Wallet Per Day</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        placeholder="No limit"
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(e.target.value ? parseInt(e.target.value, 10) : null)
                        }
                        className="font-mono bg-background"
                      />
                    </FormControl>
                    <FormDescription>
                      Stop buying a wallet's tokens once this many buys are recorded today.
                      Empty = unlimited.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="bg-muted/30 border-b pb-4">
              <CardTitle className="flex items-center gap-2 text-lg">
                <ShieldAlert className="h-5 w-5 text-orange-500" /> Risk Management
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-6">
              <FormField
                control={form.control}
                name="autoSell"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 bg-background">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Auto-Sell Enabled</FormLabel>
                      <FormDescription>
                        Automatically sell positions based on TP/SL below.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              {form.watch("autoSell") && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2 border-t border-border">
                  <FormField
                    control={form.control}
                    name="takeProfitPercent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Take Profit (%)</FormLabel>
                        <FormControl>
                          <Input 
                            {...field} 
                            value={field.value || ""} 
                            onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : null)} 
                            type="number" 
                            className="font-mono bg-background text-green-600 font-bold" 
                            placeholder="Optional"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="stopLossPercent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Stop Loss (%)</FormLabel>
                        <FormControl>
                          <Input 
                            {...field} 
                            value={field.value || ""} 
                            onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : null)} 
                            type="number" 
                            className="font-mono bg-background text-red-600 font-bold" 
                            placeholder="Optional"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button type="submit" size="lg" disabled={updateConfig.isPending} className="w-48 shadow-md">
              <Save className="h-4 w-4 mr-2" />
              {updateConfig.isPending ? "SAVING..." : "SAVE SETTINGS"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
