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
    <div className="flex flex-col h-[100dvh] w-full overflow-hidden" style={{ background: "#080810" }}>
      {/* Background mesh */}
      <div className="fixed inset-0 pointer-events-none select-none z-0">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120%] h-72 bg-violet-600/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-indigo-600/8 rounded-full blur-3xl" />
        <div className="absolute bottom-20 right-0 w-48 h-48 bg-purple-600/8 rounded-full blur-3xl" />
      </div>

      {/* Header */}
      <header className="shrink-0 relative z-10 px-4 pt-4 pb-0">
        {/* Brand row */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 rounded-2xl bg-violet-500/30 blur-sm" />
              <div className="relative w-10 h-10 rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-700 flex items-center justify-center ring-1 ring-white/10 shadow-lg shadow-violet-500/20">
                <Zap className="h-5 w-5 text-white fill-current" />
              </div>
            </div>
            <div>
              <h1 className="text-white font-bold text-base leading-tight tracking-tight">
                Zora Sniper
              </h1>
              <p className="text-violet-300/60 text-xs font-medium mt-0.5">Base · Coins Protocol</p>
            </div>
          </div>

          {/* Version badge */}
          <span className="text-[10px] font-mono text-white/20 border border-white/10 rounded-full px-2.5 py-1">
            v1.0.0-beta
          </span>
        </div>

        {/* Tab bar — pill style */}
        <div className="flex bg-white/5 rounded-2xl p-1 gap-1">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-semibold transition-all duration-200",
                  isActive
                    ? "bg-violet-600 text-white shadow-lg shadow-violet-500/20"
                    : "text-white/40 hover:text-white/70"
                )}
              >
                <item.icon className="h-3.5 w-3.5 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto relative z-10">
        {children}
      </main>
    </div>
  );
}
