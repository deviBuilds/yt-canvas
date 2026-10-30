import { ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAccount } from "@/auth/AccountContext";
import { authApi, type AllowlistEntry } from "@/auth/api";
import { Button } from "@/components/ui/button";

const when = (seconds: number) => new Date(seconds * 1000).toLocaleDateString();

/** /access, for admins: who may sign in (the allowlist). */
export function AccessView() {
  const { accounts, user } = useAccount();
  const [entries, setEntries] = useState<AllowlistEntry[] | null>(null);
  const [emails, setEmails] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(() => {
    authApi.allowlist().then(
      (result) => setEntries(result.entries),
      (err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    );
  }, []);
  useEffect(() => {
    if (user?.admin) refresh();
  }, [user?.admin, refresh]);

  if (!accounts || !user?.admin) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-8 sm:px-6">
        <h1 className="text-3xl font-bold">Access</h1>
        <p className="mt-2 text-muted-foreground">
          {accounts ? "Only admins can see who may sign in." : "Accounts are off on this server, so there's no allowlist."}
        </p>
      </div>
    );
  }

  const add = (event: FormEvent) => {
    event.preventDefault();
    const list = emails.split(/[\s,;]+/).filter(Boolean);
    if (list.length === 0) return;
    authApi.allow(list).then(
      (result) => {
        setMessage({ ok: true, text: result.added === 1 ? "Added 1 person." : `Added ${result.added} people.` });
        setEmails("");
        refresh();
      },
      (err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    );
  };

  const remove = (email: string) => {
    authApi.disallow(email).then(refresh, (err: unknown) =>
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    );
  };

  return (
    <div className="mx-auto max-w-[760px] px-4 py-8 sm:px-6">
      <h1 className="flex items-center gap-3 text-3xl font-bold">
        <ShieldCheck className="size-8" aria-hidden="true" /> Access
      </h1>
      <p className="mt-2 text-muted-foreground">
        Only these emails can sign in. Someone who signs up with another email is turned away and their new account is removed.
        Removing an email also locks out the devices that person paired.
      </p>
      <form onSubmit={add} className="mt-6 flex flex-wrap items-end gap-3 rounded-xl bg-secondary p-4" aria-label="Add people">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          Emails (separate several with commas or spaces)
          <input
            value={emails}
            onChange={(event) => setEmails(event.currentTarget.value)}
            type="text"
            inputMode="email"
            autoComplete="off"
            placeholder="name@example.com"
            className="h-10 rounded-lg border border-border bg-background px-3"
          />
        </label>
        <Button type="submit" variant="primary" disabled={!emails.trim()}>
          Add
        </Button>
        {message && <p className={`w-full text-sm ${message.ok ? "" : "text-danger"}`}>{message.text}</p>}
      </form>
      <h2 className="mt-8 text-lg font-semibold">Allowed</h2>
      {entries === null ? null : (
        <ul className="mt-2 divide-y divide-border rounded-xl bg-secondary">
          {entries.map((entry) => (
            <li key={entry.email} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{entry.email}</p>
                <p className="text-xs text-muted-foreground">
                  {entry.admin ? "Admin (set on the server)" : `Added ${when(entry.addedAt)}${entry.addedBy ? ` by ${entry.addedBy}` : ""}`}
                </p>
              </div>
              {!entry.admin && (
                <Button variant="ghost" size="sm" onClick={() => remove(entry.email)} aria-label={`Remove ${entry.email}`}>
                  <Trash2 /> Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
