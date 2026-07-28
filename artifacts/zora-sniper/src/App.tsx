import { useState, useEffect } from "react";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Layout } from '@/components/layout';
import Dashboard from '@/pages/Dashboard';
import Creators from '@/pages/Creators';
import Trades from '@/pages/Trades';
import Trade from '@/pages/Trade';
import Settings from '@/pages/Settings';
import NotFound from '@/pages/not-found';
import Login from '@/pages/Login';

const queryClient = new QueryClient();

type AuthState = "loading" | "authenticated" | "unauthenticated";

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/trade" component={Trade} />
        <Route path="/creators" component={Creators} />
        <Route path="/trades" component={Trades} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  const [auth, setAuth] = useState<AuthState>("loading");

  useEffect(() => {
    fetch("/api/auth/check", { credentials: "include" })
      .then((r) => setAuth(r.ok ? "authenticated" : "unauthenticated"))
      .catch(() => setAuth("unauthenticated"));
  }, []);

  if (auth === "loading") {
    return (
      <div
        className="flex items-center justify-center min-h-screen w-full"
        style={{ background: "#080810" }}
      >
        <div className="w-8 h-8 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
      </div>
    );
  }

  if (auth === "unauthenticated") {
    return (
      <>
        <Login onSuccess={() => setAuth("authenticated")} />
        <Toaster />
      </>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Router />
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
