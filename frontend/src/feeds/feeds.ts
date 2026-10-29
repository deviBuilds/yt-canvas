import { Gamepad2, Music, Newspaper, Radio, type LucideIcon } from "lucide-react";
import { useCallback } from "react";

import { useCachedRequest } from "@/lib/useCachedRequest";

import { feedsApi } from "./api";

/** The public YouTube topic pages the backend can read (see /api/feeds). */
export const FEEDS: Array<{ id: string; title: string; icon: LucideIcon; blurb: string }> = [
  { id: "music", title: "Music", icon: Music, blurb: "New and trending songs, charts and live performances." },
  { id: "news", title: "News", icon: Newspaper, blurb: "Top stories from news channels on YouTube." },
  { id: "live", title: "Live", icon: Radio, blurb: "Recent live streams. Streams that are live right now can't be played yet." },
  { id: "gaming", title: "Gaming", icon: Gamepad2, blurb: "Featured gaming videos." },
];

export const feedPath = (id: string) => `/feed/${id}`;

/**
 * The feeds the server offers (none when YTC_ENABLE_FEEDS is off). Until the
 * list arrives every known feed is assumed, so the sidebar doesn't jump.
 */
export function useEnabledFeeds(): { feeds: typeof FEEDS; known: boolean } {
  const fetcher = useCallback((signal: AbortSignal) => feedsApi.list(signal), []);
  const { data, error } = useCachedRequest("feeds", fetcher);
  if (!data) return { feeds: error ? [] : FEEDS, known: error !== null };
  const ids = new Set(data.feeds.map((feed) => feed.id));
  return { feeds: FEEDS.filter((feed) => ids.has(feed.id)), known: true };
}
