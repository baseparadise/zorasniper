import { Link, useLocation } from "wouter";
import { Activity, Users, History, Settings, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: Activity },
  { href: "/creators", label: "Creators", icon: Users },
  { href: "/trades", label: "Trades", icon: History },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="w-14 md:w-56 border-r border-border bg-card flex flex-col shrink-0">
        <div className="h-16 flex items-center justify-center md:justify-start md:px-5 border-b border-border">
          <div className="flex items-center gap-2 text-primary">
            <Zap className="h-6 w-6 text-blue-600 fill-current shrink-0" />
            <span className="hidden md:block font-bold text-lg tracking-tight">Zora Sniper</span>
          </div>
        </div>
        
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center justify-center md:justify-start gap-3 px-2 md:px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
                title={item.label}
              >
                <item.icon className={cn("h-4 w-4 shrink-0", isActive ? "text-primary-foreground" : "text-muted-foreground")} />
                <span className="hidden md:block">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-2 md:p-4 border-t border-border">
          <div className="hidden md:block text-xs text-muted-foreground font-mono">
            v1.0.0-beta
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto relative">
        {children}
      </main>
    </div>
  );
}
