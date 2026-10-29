import { CircleUserRound, Compass, Heart, History, House, Library, Menu, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tip } from "@/components/ui/tooltip";
import { feedPath, useEnabledFeeds } from "@/feeds/feeds";
import { readJson, writeJson } from "@/library/storage";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";
import { Link, useRouter } from "@/router/router";
import { useTheme, type ThemeMode } from "@/theme/ThemeContext";

import { SearchBar } from "../SearchBar";
import { Logo } from "./Logo";

const GUIDE_KEY = "ytc.guide.v1";

function ThemeMenu() {
  const { mode, dark, setMode } = useTheme();
  const Icon = mode === "system" ? Monitor : dark ? Moon : Sun;
  return (
    <DropdownMenu>
      <Tip label="Appearance">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Appearance">
            <Icon />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end">
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
  return to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`);
}

function GuideEntry({ to, icon: Icon, label, onNavigate }: { to: string; icon: LucideIcon; label: string; onNavigate?: () => void }) {
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
      <Icon className="size-6 shrink-0" strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function GuideSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="border-b border-border px-3 py-3 last:border-b-0">
      {title ? <h2 className="px-3 pb-1 pt-1.5 text-base font-medium">{title}</h2> : null}
      {children}
    </div>
  );
}

/** The full sidebar ("guide"), used inline on wide screens and inside the drawer. */
function Guide({ onNavigate }: { onNavigate?: () => void }) {
  const { feeds } = useEnabledFeeds();
  return (
    <nav aria-label="Main" className="flex flex-col">
      <GuideSection>
        <GuideEntry to="/" icon={House} label="Home" onNavigate={onNavigate} />
      </GuideSection>
      <GuideSection title="You">
        <GuideEntry to="/library" icon={Library} label="Library" onNavigate={onNavigate} />
        <GuideEntry to="/history" icon={History} label="History" onNavigate={onNavigate} />
        <GuideEntry to="/favorites" icon={Heart} label="Favorites" onNavigate={onNavigate} />
      </GuideSection>
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

function RailEntry({ to, icon: Icon, label }: { to: string; icon: LucideIcon; label: string }) {
  const { path } = useRouter();
  const active = isActive(path, to) || (to.startsWith("/feed/") && path.startsWith("/feed/"));
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className="flex w-16 flex-col items-center gap-1.5 rounded-[10px] pb-3.5 pt-4 text-[10px] hover:bg-secondary"
    >
      <Icon className="size-6" strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
      <span className="max-w-full truncate">{label}</span>
    </Link>
  );
}

/** The 72 px icon rail YouTube shows between the phone and wide layouts. */
function MiniGuide() {
  const { feeds } = useEnabledFeeds();
  return (
    <nav aria-label="Main" className="flex flex-col items-center gap-1 px-1 pt-1">
      <RailEntry to="/" icon={House} label="Home" />
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
      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between gap-2 bg-background px-2 sm:gap-4 sm:px-4">
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <Button variant="ghost" size="icon" aria-label="Menu" aria-expanded={inlineGuide || drawerOpen} onClick={toggleGuide}>
            <Menu />
          </Button>
          <Logo />
        </div>
        <SearchBar />
        <div className="flex shrink-0 items-center gap-1">
          <ThemeMenu />
          <Tip label="Library">
            <Button asChild variant="ghost" size="icon" className="hidden sm:inline-flex">
              <Link to="/library" aria-label="Library">
                <CircleUserRound />
              </Link>
            </Button>
          </Tip>
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
