import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

import type { MediaRef, VideoSummary } from "../api/types";

interface Location {
  path: string;
  params: URLSearchParams;
  href: string;
}

interface RouterValue extends Location {
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function readLocation(): Location {
  const { pathname, search, hash } = window.location;
  return { path: pathname, params: new URLSearchParams(search), href: pathname + search + hash };
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(readLocation);

  useEffect(() => {
    const onPop = () => setLocation(readLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string, options: { replace?: boolean } = {}) => {
    const current = window.location.pathname + window.location.search;
    if (to === current) return;
    if (options.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setLocation(readLocation());
    if (!options.replace) window.scrollTo({ top: 0 });
  }, []);

  const value = useMemo(() => ({ ...location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter must be used inside <RouterProvider>");
  return value;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

export function Link({ to, onClick, target, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (target && target !== "_self")
    ) {
      return;
    }
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} target={target} onClick={handleClick} {...rest} />;
}

// -- path builders -----------------------------------------------------------

export function watchPath(ref: MediaRef | VideoSummary, extra: { list?: string | null; t?: number | null } = {}) {
  const params = new URLSearchParams();
  if (ref.source === "demo") params.set("demo", ref.id);
  else params.set("v", ref.id);
  if (extra.list) params.set("list", extra.list);
  if (extra.t) params.set("t", String(Math.floor(extra.t)));
  return `/watch?${params.toString()}`;
}

export const searchPath = (q: string) => `/search?${new URLSearchParams({ q })}`;
export const channelPath = (ref: string) => `/channel?${new URLSearchParams({ ref })}`;
export const playlistPath = (id: string) => `/playlist?${new URLSearchParams({ list: id })}`;
