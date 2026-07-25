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
    <div className="flex flex-col h-[100dvh] w-full overflow-hidden bg-background">
      {/* Top Navbar */}
      <header className="shrink-0 border-b border-border bg-card">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-border">
          <Zap className="h-5 w-5 text-blue-600 fill-current" />
          <span className="font-bold text-base tracking-tight">Zora Sniper</span>
          <span className="ml-auto text-xs text-muted-foreground font-mono">v1.0.0-beta</span>
        </div>
        <nav className="flex overflow-x-auto scrollbar-none">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors",
                  isActive
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
