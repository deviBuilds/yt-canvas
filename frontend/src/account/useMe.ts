import { useCallback } from "react";

import { useCachedRequest } from "@/lib/useCachedRequest";

import type { Me } from "../api/types";
import { accountApi } from "./api";

const SIGNED_OUT: Me = { configured: false, signed_in: false, source: null, avatar_url: null, chips: [], detail: null };

/**
 * The YouTube sign-in state. ``known`` is false until the server answers, so
 * signed-in-only UI doesn't flash; an older server without /api/me counts as signed out.
 */
export function useMe(): { me: Me; known: boolean; retry: () => void } {
  const fetcher = useCallback((signal: AbortSignal) => accountApi.me(signal), []);
  const { data, error, retry } = useCachedRequest("me", fetcher);
  return { me: data ?? SIGNED_OUT, known: data !== null || error !== null, retry };
}
