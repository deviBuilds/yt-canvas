import { CircleCheck, CircleUserRound, RefreshCw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { useMe } from "@/account/useMe";
import { ChannelAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-secondary px-1.5 py-0.5 text-[13px]">{children}</code>;
}

/**
 * How to let yt-canvas use your YouTube session, and whether it currently is.
 * Turning it on is a server setting, so this page only explains and checks.
 */
export function SignInView() {
  const { me, known, retry } = useMe();

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
