import { LoaderCircle, MonitorSmartphone } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

import { pairingApi, type PairingRequest, type PairingStatus } from "./api";

/**
 * On another device (a phone, a car) while the server holds private data, the app is
 * replaced by this until the device is paired. This computer, and servers without private
 * data, go straight through.
 */
export function PairingGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PairingStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    pairingApi.status(controller.signal).then(setStatus, () => undefined);
    return () => controller.abort();
  }, []);
  if (status && status.required && !status.local && !status.paired) return <PairDevice />;
  return <>{children}</>;
}

function PairDevice() {
  const [name, setName] = useState("");
  const [pending, setPending] = useState<PairingRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setError(null);
    pairingApi.start(name.trim() || null).then(setPending, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    let timer = 0;
    const poll = () => {
      pairingApi.check(pending.id, controller.signal).then(
        (result) => {
          if (result.state === "paired") window.location.reload();
          else if (result.state === "waiting") timer = window.setTimeout(poll, 2000);
          else {
            setPending(null);
            setError("The code expired. Start again.");
          }
        },
        (err: unknown) => {
          if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
        },
      );
    };
    timer = window.setTimeout(poll, 2000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [pending]);

  return (
    <main className="mx-auto flex min-h-screen max-w-[640px] flex-col justify-center px-6 py-10" aria-label="Pair this device">
      <h1 className="flex items-center gap-3 text-3xl font-bold">
        <MonitorSmartphone className="size-8" aria-hidden="true" /> Pair this device
      </h1>
      <p className="mt-3 text-muted-foreground">
        This yt-canvas holds private things, like your Plex library, so it only opens for devices you've paired.
      </p>
      {pending ? (
        <section className="mt-8 rounded-2xl bg-secondary p-6 text-center" aria-live="polite">
          <p className="text-sm text-muted-foreground">On the computer running yt-canvas, open the Devices page and enter</p>
          <p className="my-4 font-mono text-6xl font-bold tracking-[0.2em]" data-testid="pairing-code">
            {pending.code}
          </p>
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Waiting for approval… The code works for 10 minutes.
          </p>
        </section>
      ) : (
        <section className="mt-8 rounded-2xl bg-secondary p-6">
          <label className="block text-sm" htmlFor="pairing-name">
            Name this device (optional)
          </label>
          <input
            id="pairing-name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="My car"
            className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3"
          />
          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
          <Button variant="primary" className="mt-4 h-11 px-6 text-base" onClick={start}>
            Pair this device
          </Button>
        </section>
      )}
    </main>
  );
}
