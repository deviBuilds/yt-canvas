import { CircleCheck, CircleUserRound, RefreshCw, Trash2, TriangleAlert, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent, type ReactNode } from "react";

import { useMe } from "@/account/useMe";
import { useAccount } from "@/auth/AccountContext";
import { authApi } from "@/auth/api";
import { ChannelAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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

/** Accounts on: upload, replace or remove your own cookies.txt; they follow your account. */
function YourYouTube({ me, known, retry }: { me: Me; known: boolean; retry: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const uploaded = Boolean(me.uploaded_at);

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!chosen) return;
    setBusy(true);
    setMessage(null);
    chosen
      .text()
      .then((text) => authApi.uploadCookies(text))
      .then(
        (result) => {
          setMessage({ ok: true, text: `Saved ${result.count} youtube.com cookies to your account. Checking them with YouTube…` });
          retry();
        },
        (err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }),
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
      </div>
    </div>
  ) : uploaded ? (
    <div className="flex items-start gap-3">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
      <div>
        <p className="font-medium">Your cookies aren't working</p>
        <p className="text-sm text-muted-foreground">{me.detail ?? "YouTube didn't accept them."} Upload a fresh cookies.txt.</p>
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
          <input ref={file} type="file" accept=".txt,text/plain" className="sr-only" onChange={upload} aria-label="cookies.txt file" />
          <Button variant="primary" disabled={busy} onClick={() => file.current?.click()}>
            <Upload /> {uploaded ? "Replace cookies.txt" : "Upload cookies.txt"}
          </Button>
          {uploaded && (
            <Button variant="secondary" disabled={busy} onClick={remove}>
              <Trash2 /> Remove
            </Button>
          )}
        </div>
        {message && <p className={`mt-3 text-sm ${message.ok ? "" : "text-danger"}`} role="status">{message.text}</p>}
      </section>

      <h2 className="mt-8 text-xl font-bold">Getting a cookies.txt</h2>
      <ol className="mt-3 list-decimal space-y-3 pl-5">
        <li>Sign in to YouTube in a browser on your computer (a secondary Google account is safer, see below).</li>
        <li>
          Export its cookies in <strong>Netscape</strong> format, either with a cookies.txt browser extension while on
          youtube.com, or with yt-dlp:{" "}
          <Code>yt-dlp --cookies-from-browser chrome --cookies cookies.txt --skip-download https://www.youtube.com</Code>.
          JSON exports don't work.
        </li>
        <li>Upload the file here. Then you can delete it from your computer.</li>
      </ol>

      <h2 className="mt-8 text-xl font-bold">Before you do</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
        <li>
          Only the file's youtube.com cookies are kept. They're encrypted with a key only this server has before they're
          stored in your account, and they're never logged, shown again or sent to any page.
        </li>
        <li>
          When YouTube refreshes them, the refreshed ones replace the stored copy, so the session keeps working. If YouTube
          signs them out, upload a fresh file.
        </li>
        <li>
          Those cookies are a Google session. Automated use of a real account can get it signed out or flagged by Google; a
          secondary account is safer. It's also further outside YouTube's Terms of Service than signed-out use.
        </li>
      </ul>
    </div>
  );
}
