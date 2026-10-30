import { ClerkProvider, SignIn, SignUp, useAuth } from "@clerk/clerk-react";
import { CircleAlert, MonitorSmartphone } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ApiError, setSessionToken } from "@/api/http";
import { Logo } from "@/components/layout/Logo";
import { Button } from "@/components/ui/button";
import { PairDevice } from "@/pairing/PairingGate";
import { pairingApi } from "@/pairing/api";
import { useRouter } from "@/router/router";
import { useTheme } from "@/theme/ThemeContext";

import { AccountContext, type AccountValue } from "./AccountContext";
import { authApi, type AccountUser } from "./api";
import { Splash } from "./AuthGate";

/** Clerk's sign-in and the server's answer to "who is this?", which decides what to show. */
export default function ClerkAccounts({ publishableKey, children }: { publishableKey: string; children: ReactNode }) {
  const { dark } = useTheme();
  const { navigate } = useRouter();
  const appearance = useMemo(
    () => ({
      // No "Secured by Clerk" or development-mode badge under the forms: the footer keeps only its
      // "Don't have an account? Sign up" line.
      layout: { unsafe_disableDevelopmentModeWarnings: true },
      elements: { footer: { "& > :not(.cl-footerAction)": { display: "none" } } },
      variables: dark
        ? { colorPrimary: "#3ea6ff", colorBackground: "#212121", colorText: "#f1f1f1", colorTextSecondary: "#aaaaaa",
            colorInputBackground: "#121212", colorInputText: "#f1f1f1", colorNeutral: "#f1f1f1" }
        : { colorPrimary: "#065fd4", colorBackground: "#ffffff", colorText: "#0f0f0f", colorTextSecondary: "#606060",
            colorInputBackground: "#ffffff", colorInputText: "#0f0f0f", colorNeutral: "#0f0f0f" },
    }),
    [dark],
  );
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      appearance={appearance}
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      afterSignOutUrl="/"
      telemetry={false}
    >
      <Accounts>{children}</Accounts>
    </ClerkProvider>
  );
}

type State =
  | { status: "checking" }
  | { status: "signed_in"; user: AccountUser }
  | { status: "signed_out" }
  | { status: "not_invited"; message: string }
  | { status: "error"; message: string };

function Accounts({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  const [state, setState] = useState<State>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);
  const signedInAs = useRef<string | null>(null);

  // Before asking the server, so the question carries the session token.
  useEffect(() => {
    setSessionToken(isSignedIn ? () => getToken() : null);
    return () => setSessionToken(null);
  }, [isSignedIn, getToken]);

  // Signed in with Clerk or not, the server decides: a paired device has no Clerk session.
  useEffect(() => {
    if (!isLoaded) return;
    const controller = new AbortController();
    authApi.me(controller.signal).then(
      (user) => setState({ status: "signed_in", user }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) setState({ status: "signed_out" });
        else if (err instanceof ApiError && err.info.code === "not_invited") setState({ status: "not_invited", message: err.message });
        else setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => controller.abort();
  }, [isLoaded, isSignedIn, attempt]);

  // Someone else signing in in this tab (or signing out elsewhere) starts from a clean page,
  // so nothing cached for the last person is shown to the next.
  const email = state.status === "signed_in" ? state.user.email : null;
  useEffect(() => {
    if (signedInAs.current && email !== signedInAs.current && state.status !== "checking") window.location.reload();
    if (email) signedInAs.current = email;
  }, [email, state.status]);

  const value = useMemo<AccountValue | null>(() => {
    if (state.status !== "signed_in") return null;
    const user = state.user;
    return {
      accounts: true,
      user,
      signOut: () => {
        const done = () => window.location.assign("/");
        if (user.via === "device") void pairingApi.forget().finally(done);
        else void signOut().finally(done);
      },
    };
  }, [state, signOut]);

  if (state.status === "checking" || !isLoaded) return <Splash />;
  if (value) return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
  if (state.status === "not_invited") {
    return <NotInvited message={state.message} onSignOut={() => void signOut().finally(() => window.location.assign("/"))} />;
  }
  if (state.status === "error") {
    return (
      <Screen>
        <p className="flex items-start gap-2 text-danger" role="alert">
          <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" /> {state.message}
        </p>
        <Button variant="primary" className="mt-6" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </Screen>
    );
  }
  return <SignInScreen />;
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-[640px] flex-col items-center justify-center gap-6 px-6 py-10">
      <Logo />
      <div className="flex w-full flex-col items-center">{children}</div>
    </main>
  );
}

function SignInScreen() {
  const { path } = useRouter();
  const [pairing, setPairing] = useState(false);
  if (pairing) return <PairDevice accounts onCancel={() => setPairing(false)} />;
  return (
    <Screen>
      {path.startsWith("/sign-up") ? <SignUp routing="hash" signInUrl="/sign-in" /> : <SignIn routing="hash" signUpUrl="/sign-up" />}
      <Button variant="ghost" className="mt-6" onClick={() => setPairing(true)}>
        <MonitorSmartphone /> Pair with a code instead
      </Button>
      <p className="mt-2 max-w-sm text-center text-xs text-muted-foreground">
        For a car or TV: show a code here and approve it on a device where you're signed in.
      </p>
    </Screen>
  );
}

function NotInvited({ message, onSignOut }: { message: string; onSignOut: () => void }) {
  return (
    <Screen>
      <h1 className="text-2xl font-bold">You're not on the list yet</h1>
      <p className="mt-3 text-center text-muted-foreground">{message}</p>
      <p className="mt-1 text-center text-sm text-muted-foreground">
        Ask whoever runs this yt-canvas to add your email, then sign in again.
      </p>
      <Button variant="primary" className="mt-6" onClick={onSignOut}>
        Sign out
      </Button>
    </Screen>
  );
}
