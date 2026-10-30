import { Clapperboard, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { plexApi, type PlexStatus, type SignIn } from "./api";

type Step = { kind: "idle" } | { kind: "waiting"; signIn: SignIn; blocked: boolean } | { kind: "error"; message: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Connect Plex: yt-canvas asks plex.tv for a sign-in code, Plex's own page opens in a new
 * tab to approve it (signing in there if needed), and this page notices the approval.
 */
export function Connect({ status, onConnected }: { status: PlexStatus | null; onConnected: (status: PlexStatus) => void }) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const tab = useRef<Window | null>(null);

  const start = () => {
    // Open the tab inside the click, so popup blockers allow it; point it at Plex once the code exists.
    tab.current = window.open("about:blank", "_blank");
    plexApi.startSignIn().then(
      (signIn) => {
        if (tab.current && !tab.current.closed) {
          tab.current.opener = null;
          tab.current.location.href = signIn.auth_url;
        }
        setStep({ kind: "waiting", signIn, blocked: !tab.current });
      },
      (err: unknown) => {
        tab.current?.close();
        setStep({ kind: "error", message: message(err) });
      },
    );
  };

  useEffect(() => {
    if (step.kind !== "waiting") return;
    const controller = new AbortController();
    let timer = 0;
    const poll = () => {
      plexApi.checkSignIn(step.signIn.pin_id, controller.signal).then(
        (state) => {
          if (state.state === "waiting") timer = window.setTimeout(poll, 2000);
          else if (state.state === "connected" && state.status) onConnected(state.status);
          else if (state.state === "no_server") setStep({ kind: "error", message: "You're signed in, but none of your Plex servers answered from this computer." });
          else setStep({ kind: "error", message: "The sign-in code expired. Try again." });
        },
        (err: unknown) => {
          if (!controller.signal.aborted) setStep({ kind: "error", message: message(err) });
        },
      );
    };
    timer = window.setTimeout(poll, 1500);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [step, onConnected]);

  return (
    <section className="mt-6 rounded-xl bg-secondary p-6" aria-label="Connect Plex">
      <h2 className="flex items-center gap-2 text-xl font-semibold">
        <Clapperboard className="size-6" aria-hidden="true" /> Connect your Plex account
      </h2>
      {status?.signed_in && !status.connected && (
        <p className="mt-2 text-sm text-danger">You're signed in as {status.account}, but no server is connected yet.</p>
      )}
      {step.kind === "waiting" ? (
        <div className="mt-4" role="status">
          <p className="flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Waiting for you to approve yt-canvas in the Plex tab…
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {step.blocked ? "Your browser blocked the new tab. " : "Didn't see it? "}
            <a href={step.signIn.auth_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-link">
              Open Plex sign-in <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </p>
        </div>
      ) : (
        <>
          <p className="mt-2 text-muted-foreground">
            Plex's own page opens in a new tab. Sign in there and approve yt-canvas. Your password never goes through
            yt-canvas, and the access Plex grants stays on this computer.
          </p>
          {step.kind === "error" && <p className="mt-3 text-sm text-danger">{step.message}</p>}
          <Button variant="primary" className="mt-4" onClick={start}>
            Connect Plex
          </Button>
        </>
      )}
    </section>
  );
}
