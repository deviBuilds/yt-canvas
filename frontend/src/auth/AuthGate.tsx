import { LoaderCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";

import { PairingGate } from "@/pairing/PairingGate";

import { authApi, type AuthConfig } from "./api";

// Clerk's SDK only loads when the server has accounts on.
const ClerkAccounts = lazy(() => import("./ClerkAccounts"));

export function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status" aria-label="Loading">
      <LoaderCircle className="size-8 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

/**
 * Accounts on: nothing but sign-in (or pairing with a code) until someone on the allowlist is
 * signed in. No-login mode: the device pairing gate, as before.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    authApi.config(controller.signal).then(setConfig, () => {
      // An unreachable or older server: carry on as before (the health banner says what's wrong).
      if (!controller.signal.aborted) setConfig({ accounts: false });
    });
    return () => controller.abort();
  }, []);
  if (config === null) return <Splash />;
  if (!config.accounts || !config.clerk_publishable_key) return <PairingGate>{children}</PairingGate>;
  return (
    <Suspense fallback={<Splash />}>
      <ClerkAccounts publishableKey={config.clerk_publishable_key}>{children}</ClerkAccounts>
    </Suspense>
  );
}
