import { MonitorSmartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAccount } from "@/auth/AccountContext";
import { Button } from "@/components/ui/button";
import { pairingApi, type PairedDevice, type PairingRequest } from "@/pairing/api";

const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();

/**
 * /devices: approve a device's pairing code, and see or revoke paired devices. In no-login mode
 * on this computer only; with accounts on, anyone signed in, for their own account.
 */
export function DevicesView() {
  const { accounts, user } = useAccount();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [listing, setListing] = useState<{ devices: PairedDevice[]; requests: PairingRequest[]; current?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    pairingApi.devices().then(
      (result) => {
        setListing(result);
        setError(null);
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const approve = (event: FormEvent) => {
    event.preventDefault();
    pairingApi.approve(code.trim()).then(
      (request) => {
        setMessage({ ok: true, text: `Approved ${request.name}. It finishes pairing on its own in a moment.` });
        setCode("");
        refresh();
      },
      (err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    );
  };

  return (
    <div className="mx-auto max-w-[760px] px-4 py-8 sm:px-6">
      <h1 className="flex items-center gap-3 text-3xl font-bold">
        <MonitorSmartphone className="size-8" aria-hidden="true" /> Devices
      </h1>
      <p className="mt-2 text-muted-foreground">
        {accounts
          ? "Pair a car, a TV or anything else where signing in is awkward to your account. On the device, open yt-canvas and choose Pair with a code, then type the code it shows here. It gets your Plex, YouTube and library, and stays paired until you revoke it."
          : "While yt-canvas holds private things (a connected Plex, YouTube sign-in), other devices, like your phone or car through a tunnel, need pairing. On the device, choose Pair this device, then type its code here."}
      </p>
      {error ? (
        <p className="mt-6 text-sm text-danger">{error}</p>
      ) : (
        <>
          {user?.via === "device" ? (
            <p className="mt-6 rounded-xl bg-secondary p-4 text-sm">
              This device is paired to {user.email}. Approve new devices from a phone or computer where you signed in.
            </p>
          ) : (
            <form onSubmit={approve} className="mt-6 flex flex-wrap items-end gap-3 rounded-xl bg-secondary p-4" aria-label="Approve a device">
              <label className="flex flex-col gap-1 text-sm">
                Code shown on the device
                <input
                  value={code}
                  onChange={(event) => setCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="123456"
                  className="h-10 w-40 rounded-lg border border-border bg-background px-3 font-mono text-lg tracking-widest"
                />
              </label>
              <Button type="submit" variant="primary" disabled={code.length !== 6}>
                Approve
              </Button>
              {message && <p className={`w-full text-sm ${message.ok ? "" : "text-danger"}`}>{message.text}</p>}
            </form>
          )}
          {listing && listing.requests.length > 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              Waiting: {listing.requests.map((r) => r.name).join(", ")}. Check the code on the device itself before approving.
            </p>
          )}
          <h2 className="mt-8 text-lg font-semibold">Paired devices</h2>
          {!listing ? null : listing.devices.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border rounded-xl bg-secondary">
              {listing.devices.map((device) => (
                <li key={device.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="font-medium">
                      {device.name}
                      {listing.current === device.id && <span className="ml-2 text-xs text-muted-foreground">(this device)</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Paired {when(device.created)} · last seen {when(device.last_seen)}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void pairingApi.revoke(device.id).then(refresh)} aria-label={`Revoke ${device.name}`}>
                    <Trash2 /> Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
