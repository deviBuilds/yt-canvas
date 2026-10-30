import { CircleCheck, CircleUserRound, ClipboardPaste, RefreshCw, RotateCw, Trash2, TriangleAlert, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent, type ReactNode } from "react";

import { useMe } from "@/account/useMe";
import { useAccount } from "@/auth/AccountContext";
import { authApi, type CookieFormat } from "@/auth/api";
import { ChannelAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/api/http";
import type { Me } from "@/api/types";

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-secondary px-1.5 py-0.5 text-[13px]">{children}</code>;
}

/**
 * How to let yt-canvas use your YouTube session, and whether it currently is. In no-login mode
 * turning it on is a server setting, so this page only explains and checks; with accounts on,
 * each person uploads their own cookies.txt here.
 */
export function SignInView() {
  const { me, known, retry } = useMe();
  const { accounts } = useAccount();
  if (accounts) return <YourYouTube me={me} known={known} retry={retry} />;

  const status = !known ? (
    <p className="text-sm text-muted-foreground">Checking…</p>
  ) : me.signed_in ? (
    <div className="flex items-center gap-4">
      <ChannelAvatar name="You" src={me.avatar_url} className="size-12" />
      <div>
        <p className="flex items-center gap-2 font-medium">
          <CircleCheck className="size-5 text-[#2ba640]" aria-hidden="true" /> Signed in to YouTube
        </p>
        <p className="text-sm text-muted-foreground">Using cookies from {me.source ?? "your browser"}.</p>
      </div>
    </div>
  ) : me.configured ? (
    <div className="flex items-start gap-3">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
      <div>
        <p className="font-medium">Sign-in is set up ({me.source}) but isn't working</p>
        <p className="text-sm text-muted-foreground">{me.detail ?? "YouTube didn't accept the session."}</p>
      </div>
    </div>
  ) : (
    <div className="flex items-start gap-3">
      <CircleUserRound className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm">
        <span className="font-medium">Not signed in.</span> yt-canvas is using YouTube without an account.
      </p>
    </div>
  );

  return (
    <div className="mx-auto max-w-[760px] px-4 py-8 sm:px-6">
      <h1 className="text-3xl font-bold">Sign in with YouTube</h1>
      <p className="mt-2 text-muted-foreground">
        yt-canvas can reuse the YouTube session from a browser on this computer, so Home shows your recommendations and the
        sidebar gets Subscriptions, History, Watch later and Liked videos. It's off until you turn it on.
      </p>

      <section className="mt-6 rounded-xl bg-secondary p-4" aria-label="Status">
        <div className="flex items-start justify-between gap-4">
          {status}
          <Button variant="ghost" size="sm" onClick={retry}>
            <RefreshCw /> Check again
          </Button>
        </div>
      </section>

      <h2 className="mt-8 text-xl font-bold">Turn it on</h2>
      <ol className="mt-3 list-decimal space-y-3 pl-5">
        <li>Sign in to YouTube in Chrome (or Safari, Firefox, Brave, Edge…) on this computer.</li>
        <li>
          Add one line to <Code>.env</Code> in the yt-canvas folder: <Code>YTC_YTDLP_COOKIES_FROM_BROWSER=chrome</Code>. Use
          the browser you signed in with, e.g. <Code>safari</Code>, or <Code>chrome:Profile 1</Code> for another Chrome
          profile. A Netscape <Code>cookies.txt</Code> also works: <Code>YTC_YTDLP_COOKIES_FILE=/path/to/cookies.txt</Code>.
        </li>
        <li>
          Restart the server (<Code>make dev</Code>). On macOS, allow Keychain access when asked so the browser's cookies
          can be read; choose “Always Allow” to avoid repeated prompts.
        </li>
        <li>
          Optional: <Code>YTC_MARK_WATCHED=true</Code> also marks what you watch here as watched on YouTube, so it shapes
          your recommendations.
        </li>
      </ol>

      <h2 className="mt-8 text-xl font-bold">Before you do</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
        <li>
          Those cookies are your whole Google session, not just YouTube. yt-canvas reads them only when it needs them, keeps
          only the youtube.com ones in memory, and never stores, logs or sends them to this page.
        </li>
        <li>
          While sign-in is on, the server only answers requests from this computer. Don't expose it on a network.
        </li>
        <li>
          Automated use of a real account can get it signed out or flagged by Google; a secondary account is safer. It's also
          further outside YouTube's Terms of Service than signed-out use.
        </li>
        <li>To stop, remove the line from <Code>.env</Code> and restart, or sign out of YouTube in that browser.</li>
      </ul>
    </div>
  );
}

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString();

/** "just now", "12 minutes ago", "3 hours ago", or the day. */
export function since(seconds: number, now = Date.now() / 1000): string {
  const minutes = Math.floor((now - seconds) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `on ${day(seconds)}`;
}

const failure = (err: unknown) =>
  err instanceof ApiError && err.info.hint ? `${err.message} ${err.info.hint}` : err instanceof Error ? err.message : String(err);

const FORMAT_NAMES: Record<CookieFormat, string> = { netscape: "a cookies.txt", json: "a JSON export", header: "a Cookie header" };

/**
 * Accounts on: upload or paste your YouTube cookies, replace or remove them; they follow your account.
 * A cookies.txt, a JSON export or a Cookie header all work: the server converts them to a cookies.txt.
 */
function YourYouTube({ me, known, retry }: { me: Me; known: boolean; retry: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const uploaded = Boolean(me.uploaded_at);

  const save = (text: Promise<string>) => {
    setBusy(true);
    setMessage(null);
    text
      .then((body) => authApi.uploadCookies(body))
      .then(
        (result) => {
          setMessage({
            ok: true,
            text: `Saved ${result.count} youtube.com cookies from ${FORMAT_NAMES[result.format]} to your account. Checking them with YouTube…`,
          });
          // Don't keep cookie values around in the page.
          setPasted("");
          setPasting(false);
          retry();
        },
        (err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => setBusy(false));
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (chosen) save(chosen.text());
  };

  const renew = () => {
    setBusy(true);
    setMessage(null);
    authApi
      .renewCookies()
      .then(
        (result) => {
          setMessage({
            ok: true,
            text: result.refreshed.length
              ? `Renewed: YouTube still signs you in and refreshed ${result.refreshed.length} of your cookies.`
              : "Renewed: YouTube still signs you in; nothing needed refreshing.",
          });
          retry();
        },
        (err: unknown) => {
          setMessage({ ok: false, text: failure(err) });
          retry();
        },
      )
      .finally(() => setBusy(false));
  };

  const remove = () => {
    setBusy(true);
    authApi
      .deleteCookies()
      .then(
        () => {
          setMessage({ ok: true, text: "Removed. yt-canvas now uses YouTube without your account." });
          retry();
        },
        (err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => setBusy(false));
  };

  const status = !known ? (
    <p className="text-sm text-muted-foreground">Checking…</p>
  ) : me.signed_in ? (
    <div className="flex items-center gap-4">
      <ChannelAvatar name="You" src={me.avatar_url} className="size-12" />
      <div>
        <p className="flex items-center gap-2 font-medium">
          <CircleCheck className="size-5 text-[#2ba640]" aria-hidden="true" /> Signed in to YouTube
        </p>
        <p className="text-sm text-muted-foreground">
          With the {me.cookie_count ?? ""} cookies you uploaded{me.uploaded_at ? ` on ${day(me.uploaded_at)}` : ""}.
        </p>
        <p className="text-sm text-muted-foreground">
          {me.renewed_at ? `Last renewed ${since(me.renewed_at)}. ` : ""}They're renewed every few hours, so they stay
          fresh while you're not watching.
        </p>
      </div>
    </div>
  ) : uploaded ? (
    <div className="flex items-start gap-3">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
      <div>
        <p className="font-medium">Your cookies aren't working</p>
        <p className="text-sm text-muted-foreground">
          {me.detail ?? "YouTube didn't accept them."} Upload fresh ones, exported from a private window (see below).
        </p>
      </div>
    </div>
  ) : (
    <div className="flex items-start gap-3">
      <CircleUserRound className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm">
        <span className="font-medium">Not signed in.</span> yt-canvas is using YouTube without an account.
      </p>
    </div>
  );

  return (
    <div className="mx-auto max-w-[760px] px-4 py-8 sm:px-6">
      <h1 className="text-3xl font-bold">Your YouTube</h1>
      <p className="mt-2 text-muted-foreground">
        Upload your YouTube cookies once and they follow your yt-canvas account to every device: Home shows your
        recommendations, the sidebar gets Subscriptions, History, Watch later and Liked videos, and age-restricted or
        members-only videos your account can see are tried too.
      </p>

      <section className="mt-6 rounded-xl bg-secondary p-4" aria-label="Status">
        <div className="flex items-start justify-between gap-4">
          {status}
          <Button variant="ghost" size="sm" onClick={retry}>
            <RefreshCw /> Check again
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <input
            ref={file}
            type="file"
            accept=".txt,.json,text/plain,application/json"
            className="sr-only"
            onChange={upload}
            aria-label="Cookies file"
          />
          <Button variant="primary" disabled={busy} onClick={() => file.current?.click()}>
            <Upload /> {uploaded ? "Replace with a file" : "Upload a file"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setPasting((open) => !open)} aria-expanded={pasting}>
            <ClipboardPaste /> Paste instead
          </Button>
          {uploaded && (
            <Button variant="secondary" disabled={busy} onClick={renew}>
              <RotateCw /> Renew now
            </Button>
          )}
          {uploaded && (
            <Button variant="secondary" disabled={busy} onClick={remove}>
              <Trash2 /> Remove
            </Button>
          )}
        </div>
        {pasting && (
          <form
            className="mt-4 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (pasted.trim()) save(Promise.resolve(pasted));
            }}
          >
            <label className="text-sm" htmlFor="pasted-cookies">
              Paste a cookies.txt, a JSON export or a Cookie header
            </label>
            <textarea
              id="pasted-cookies"
              value={pasted}
              onChange={(event) => setPasted(event.currentTarget.value)}
              rows={7}
              spellCheck={false}
              autoComplete="off"
              placeholder={'[{"domain": ".youtube.com", "name": "SID", "value": "…"}, …]'}
              className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
            />
            <div className="flex gap-3">
              <Button type="submit" variant="primary" disabled={busy || !pasted.trim()}>
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setPasted("");
                  setPasting(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {message && <p className={`mt-3 text-sm ${message.ok ? "" : "text-danger"}`} role="status">{message.text}</p>}
      </section>

      <h2 className="mt-8 text-xl font-bold">Getting your cookies</h2>
      <ol className="mt-3 list-decimal space-y-3 pl-5">
        <li>
          Open a private (incognito) window on your computer and sign in to YouTube there (a secondary Google account is
          safer, see below).
        </li>
        <li>
          With youtube.com open, export its cookies in any of these, then upload the file or paste what you copied:
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <strong>JSON</strong>, from a cookie extension such as Cookie-Editor or EditThisCookie (Export, or Export as
              JSON).
            </li>
            <li>
              <strong>cookies.txt</strong> (Netscape format), from a cookies.txt extension or from yt-dlp:{" "}
              <Code>yt-dlp --cookies-from-browser chrome --cookies cookies.txt --skip-download https://www.youtube.com</Code>
            </li>
            <li>
              <strong>A Cookie header</strong>, copied from a youtube.com request in the browser's developer tools
              (Network, a request, Request Headers, cookie).
            </li>
          </ul>
        </li>
        <li>
          Close the private window without signing out, and give this export to yt-canvas only. When two copies of one
          session drift apart (another app using the same export, or the browser you exported from), Google ends the
          session for both.
        </li>
        <li>It's converted to a cookies.txt on the server. Then you can delete the export from your computer.</li>
      </ol>

      <h2 className="mt-8 text-xl font-bold">Before you do</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
        <li>
          Only the youtube.com cookies are kept. They're encrypted with a key only this server has before they're
          stored in your account, and they're never logged, shown again or sent to any page.
        </li>
        <li>
          yt-canvas keeps them fresh: whatever YouTube refreshes while you watch replaces the stored copy, and every few
          hours it visits youtube.com with them for the same reason (Renew now does it at once). If YouTube signs them
          out, upload a fresh export.
        </li>
        <li>
          Those cookies are a Google session. Automated use of a real account can get it signed out or flagged by Google; a
          secondary account is safer. It's also further outside YouTube's Terms of Service than signed-out use.
        </li>
      </ul>
    </div>
  );
}
