import { Clock, History, SquarePlay, ThumbsUp, type LucideIcon } from "lucide-react";

import type { PersonalFeed } from "./api";

/** The signed-in YouTube lists, with YouTube's names (see /api/me/feed). */
export const PERSONAL_FEEDS: Record<Exclude<PersonalFeed, "recommended">, { title: string; icon: LucideIcon }> = {
  subscriptions: { title: "Subscriptions", icon: SquarePlay },
  history: { title: "History", icon: History },
  watch_later: { title: "Watch later", icon: Clock },
  liked: { title: "Liked videos", icon: ThumbsUp },
};

export const isPersonalFeed = (id: string): id is keyof typeof PERSONAL_FEEDS => id in PERSONAL_FEEDS;
export const personalFeedPath = (id: keyof typeof PERSONAL_FEEDS) => `/feed/${id}`;
