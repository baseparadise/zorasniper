import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useListCreators, 
  useAddCreator, 
  useRemoveCreator, 
  useUpdateCreator,
  getListCreatorsQueryKey 
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Trash2, UserPlus, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatAddress, getBasescanAddressLink } from "@/lib/utils";

export default function Creators() {
  const { data: creators = [], isLoading } = useListCreators();
  const addCreator = useAddCreator();
  const removeCreator = useRemoveCreator();
  const updateCreator = useUpdateCreator();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");

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

  return (
    <div className="p-8 space-y-8 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Creator Whitelist</h1>
        <p className="text-muted-foreground mt-2">Manage specific wallet addresses to automatically snipe when they deploy new Zora coins.</p>
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
                      {c.label || <span className="text-muted-foreground italic">Unnamed</span>}
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
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleRemove(c.address)}
                        disabled={removeCreator.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
