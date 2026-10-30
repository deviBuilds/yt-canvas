import { Blocks, CircleUserRound, Compass, Heart, History, Library, LogIn, Menu, UserRound, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PERSONAL_FEEDS, personalFeedPath } from "@/account/feeds";
import { useMe } from "@/account/useMe";
import { APP_MODULES, appPath } from "@/apps/registry";
import { useApps } from "@/apps/store";
import { ChannelAvatar } from "@/components/ui/avatar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tip } from "@/components/ui/tooltip";
import { feedPath, useEnabledFeeds } from "@/feeds/feeds";
import { readJson, writeJson } from "@/library/storage";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";
import { Link, useRouter } from "@/router/router";
import { useTheme, type ThemeMode } from "@/theme/ThemeContext";

import { SearchBar } from "../SearchBar";
import { HomeIcon } from "./HomeIcon";
import { Logo } from "./Logo";

const GUIDE_KEY = "ytc.guide.v1";

/**
 * The avatar menu at the top right, where YouTube keeps your account. Signed in
 * (opt-in, see /signin) it shows your YouTube avatar and lists; otherwise it
 * holds this browser's library and the appearance setting.
 */
function AccountMenu() {
  const { mode, setMode } = useTheme();
  const { navigate } = useRouter();
  const { me } = useMe();
  const avatar = (size: string) =>
    me.signed_in ? (
      <ChannelAvatar name="You" src={me.avatar_url} className={size} />
    ) : (
      <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-[#7e57c2] text-white", size)}>
        <UserRound className="size-[60%]" strokeWidth={2} aria-hidden="true" />
      </span>
    );
  return (
    <DropdownMenu>
      <Tip label="You">
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Library and appearance" className="ml-2 flex size-10 cursor-pointer items-center justify-center rounded-full">
            {avatar("size-8")}
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-72">
        <div className="flex items-center gap-4 px-4 pb-3 pt-2">
          {avatar("size-10")}
          <div className="min-w-0">
            <p className="font-medium">{me.signed_in ? "Signed in to YouTube" : "You"}</p>
            <p className="text-sm text-muted-foreground">
              {me.signed_in ? `Using ${me.source ?? "browser"} cookies` : "Saved in this browser"}
            </p>
          </div>
        </div>
        <DropdownMenuSeparator />
        {me.signed_in
          ? (["history", "watch_later", "liked"] as const).map((id) => {
              const { title, icon: Icon } = PERSONAL_FEEDS[id];
              return (
                <DropdownMenuItem key={id} onSelect={() => navigate(personalFeedPath(id))}>
                  <Icon /> {title}
                </DropdownMenuItem>
              );
            })
          : null}
        <DropdownMenuItem onSelect={() => navigate("/library")}>
          <Library /> Library
        </DropdownMenuItem>
        {me.signed_in ? null : (
          <>
            <DropdownMenuItem onSelect={() => navigate("/history")}>
              <History /> History
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate("/favorites")}>
              <Heart /> Favorites
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onSelect={() => navigate("/signin")}>
          <LogIn /> {me.signed_in ? "YouTube sign-in" : "Sign in with YouTube"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={(value) => setMode(value as ThemeMode)}>
          <DropdownMenuRadioItem value="system">Use device theme</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark theme</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">Light theme</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function isActive(path: string, to: string) {
  // "/apps" lists the apps; each app has its own entry for /apps/<id>.
  return to === "/" || to === "/apps" ? path === to : path === to || path.startsWith(`${to}/`);
}

function GuideEntry({ to, icon: Icon, label, onNavigate }: { to: string; icon: LucideIcon | "home"; label: string; onNavigate?: () => void }) {
  const { path } = useRouter();
  const active = isActive(path, to);
  return (
    <Link
      to={to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-10 items-center gap-6 rounded-[10px] px-3 text-sm hover:bg-secondary",
        active && "bg-secondary font-medium hover:bg-secondary-hover",
      )}
    >
      {Icon === "home" ? (
        <HomeIcon className="size-6 shrink-0" filled={active} />
      ) : (
        <Icon className="size-6 shrink-0" strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
      )}
      <span className="truncate">{label}</span>
    </Link>
  );
}

function GuideSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="border-b border-border py-3 pl-3 pr-6 last:border-b-0">
      {title ? <h2 className="px-3 pb-1 pt-1.5 text-base font-medium leading-[22px]">{title}</h2> : null}
      {children}
    </div>
  );
}

/** The full sidebar ("guide"), used inline on wide screens and inside the drawer. */
function Guide({ onNavigate }: { onNavigate?: () => void }) {
  const { feeds } = useEnabledFeeds();
  const { me, known } = useMe();
  const apps = useApps();
  const personal = (id: keyof typeof PERSONAL_FEEDS) => (
    <GuideEntry to={personalFeedPath(id)} icon={PERSONAL_FEEDS[id].icon} label={PERSONAL_FEEDS[id].title} onNavigate={onNavigate} />
  );
  return (
    <nav aria-label="Main" className="flex flex-col">
      <GuideSection>
        <GuideEntry to="/" icon="home" label="Home" onNavigate={onNavigate} />
        {me.signed_in ? personal("subscriptions") : null}
      </GuideSection>
      {me.signed_in ? (
        <GuideSection title="You">
          {personal("history")}
          {personal("watch_later")}
          {personal("liked")}
          <GuideEntry to="/library" icon={Library} label="Library" onNavigate={onNavigate} />
          <GuideEntry to="/favorites" icon={Heart} label="Favorites" onNavigate={onNavigate} />
        </GuideSection>
      ) : (
        <GuideSection title="You">
          <GuideEntry to="/library" icon={Library} label="Library" onNavigate={onNavigate} />
          <GuideEntry to="/history" icon={History} label="History" onNavigate={onNavigate} />
          <GuideEntry to="/favorites" icon={Heart} label="Favorites" onNavigate={onNavigate} />
        </GuideSection>
      )}
      {known && !me.signed_in ? (
        <GuideSection>
          <p className="px-3 py-1 text-sm leading-5">Sign in to see your recommendations, subscriptions and playlists.</p>
          <Button asChild variant="outline" size="sm" className="ml-3 mt-2">
            <Link to="/signin" onClick={onNavigate}>
              <CircleUserRound /> Sign in
            </Link>
          </Button>
        </GuideSection>
      ) : null}
      {apps.listing?.available ? (
        <GuideSection title="Apps">
          {apps.enabled.map((app) => (
            <GuideEntry key={app.id} to={appPath(app.id)} icon={APP_MODULES[app.id]?.icon ?? Blocks} label={app.name} onNavigate={onNavigate} />
          ))}
          <GuideEntry to="/apps" icon={Blocks} label={apps.enabled.length > 0 ? "Manage apps" : "Add apps"} onNavigate={onNavigate} />
        </GuideSection>
      ) : null}
      {feeds.length > 0 ? (
        <GuideSection title="Explore">
          {feeds.map((feed) => (
            <GuideEntry key={feed.id} to={feedPath(feed.id)} icon={feed.icon} label={feed.title} onNavigate={onNavigate} />
          ))}
        </GuideSection>
      ) : null}
      <p className="px-6 py-4 text-xs leading-relaxed text-muted-foreground">
        yt-canvas plays media extracted with yt-dlp, outside YouTube’s official embedded player. Deployments must respect
        content rights and YouTube’s Terms of Service.
      </p>
    </nav>
  );
}

function RailEntry({ to, icon: Icon, label }: { to: string; icon: LucideIcon | "home"; label: string }) {
  const { path } = useRouter();
  const personal = /^\/feed\/(subscriptions|history|watch_later|liked)$/;
  const active = isActive(path, to) || (to.startsWith("/feed/") && !personal.test(to) && path.startsWith("/feed/") && !personal.test(path));
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className="flex h-[76px] w-16 flex-col items-center gap-1.5 rounded-[10px] pt-4 text-[10px] hover:bg-secondary"
    >
      {Icon === "home" ? (
        <HomeIcon className="size-6" filled={active} />
      ) : (
        <Icon className="size-6" strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
      )}
      <span className="max-w-full truncate">{label}</span>
    </Link>
  );
}

/** The 72 px icon rail YouTube shows between the phone and wide layouts. */
function MiniGuide() {
  const { feeds } = useEnabledFeeds();
  const { me } = useMe();
  return (
    <nav aria-label="Main" className="flex flex-col items-center px-1 pt-1">
      <RailEntry to="/" icon="home" label="Home" />
      {me.signed_in ? <RailEntry to={personalFeedPath("subscriptions")} icon={PERSONAL_FEEDS.subscriptions.icon} label="Subscriptions" /> : null}
      {feeds[0] ? <RailEntry to={feedPath(feeds[0].id)} icon={Compass} label="Explore" /> : null}
      <RailEntry to="/library" icon={CircleUserRound} label="You" />
    </nav>
  );
}

export function AppShell({ banner, children }: { banner?: ReactNode; children: ReactNode }) {
  const { path, href } = useRouter();
  const watching = path === "/watch";
  const wide = useMediaQuery("(min-width: 1312px)");
  const medium = useMediaQuery("(min-width: 792px)");
  const [expanded, setExpanded] = useState(() => readJson(GUIDE_KEY, (v) => (typeof v === "boolean" ? v : null), true));
  const [drawerOpen, setDrawerOpen] = useState(false);

  const inlineGuide = !watching && wide && expanded;
  const rail = !watching && medium && !inlineGuide;

  useEffect(() => setDrawerOpen(false), [href]);
  useEffect(() => {
    if (inlineGuide) setDrawerOpen(false);
  }, [inlineGuide]);

  const toggleGuide = useCallback(() => {
    if (!watching && wide) {
      setExpanded((on) => {
        writeJson(GUIDE_KEY, !on);
        return !on;
      });
    } else {
      setDrawerOpen((open) => !open);
    }
  }, [watching, wide]);

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only z-[60] rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:left-2 focus:top-2"
      >
        Skip to content
      </a>
      <header className="frosted fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between gap-2 px-2 sm:gap-4 sm:px-4">
        <div className="flex shrink-0 items-center">
          <Button variant="ghost" size="icon" aria-label="Menu" aria-expanded={inlineGuide || drawerOpen} onClick={toggleGuide}>
            <Menu />
          </Button>
          <Logo />
        </div>
        <SearchBar />
        {/* As wide as YouTube's Create / notifications / avatar group, so the search box lands where YouTube's does. */}
        <div className="flex shrink-0 items-center justify-end lg:min-w-[225px]">
          <AccountMenu />
        </div>
      </header>

      {inlineGuide ? (
        <aside className="fixed bottom-0 left-0 top-14 z-30 w-60 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
          <Guide />
        </aside>
      ) : null}
      {rail ? (
        <aside className="fixed bottom-0 left-0 top-14 z-30 w-[72px] overflow-y-auto">
          <MiniGuide />
        </aside>
      ) : null}

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent aria-describedby={undefined}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Pages and YouTube feeds</SheetDescription>
          <div className="flex h-14 shrink-0 items-center gap-2 px-4">
            <Button variant="ghost" size="icon" aria-label="Close menu" onClick={() => setDrawerOpen(false)}>
              <Menu />
            </Button>
            <Logo onClick={() => setDrawerOpen(false)} />
          </div>
          <div className="overflow-y-auto">
            <Guide onNavigate={() => setDrawerOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      <div className={cn("pt-14", inlineGuide && "pl-60", rail && "pl-[72px]")}>
        {banner}
        <main id="main" tabIndex={-1} className="outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
