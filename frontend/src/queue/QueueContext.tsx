import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { videoKey, type MediaRef, type VideoSummary } from "../api/types";
import { asArray, asVideo, readJson, writeJson } from "../library/storage";

const QUEUE_KEY = "ytc.queue.v1";
const MAX_QUEUE = 500;

interface QueueState {
  items: VideoSummary[];
  index: number;
  label: string | null;
  /** Playlist the queue was built from, if any. */
  listId: string | null;
  autoplay: boolean;
}

const EMPTY: QueueState = { items: [], index: -1, label: null, listId: null, autoplay: true };

function loadQueue(): QueueState {
  return readJson<QueueState>(
    QUEUE_KEY,
    (value) => {
      const v = value as Partial<QueueState> | null;
      const items = asArray(v?.items, asVideo, MAX_QUEUE);
      if (!items) return null;
      const index = typeof v?.index === "number" && v.index < items.length ? v.index : -1;
      return {
        items,
        index,
        label: typeof v?.label === "string" ? v.label : null,
        listId: typeof v?.listId === "string" ? v.listId : null,
        autoplay: v?.autoplay !== false,
      };
    },
    EMPTY,
    typeof window !== "undefined" ? window.sessionStorage : undefined,
  );
}

export interface QueueValue extends QueueState {
  current: VideoSummary | null;
  hasNext: boolean;
  hasPrevious: boolean;
  /** Replace the queue with a list (e.g. a playlist) and select ``start``. */
  playList: (items: VideoSummary[], start: VideoSummary, meta?: { label?: string | null; listId?: string | null }) => void;
  /** Select ``video``: jump to it if queued, otherwise insert it after the current item. */
  select: (video: VideoSummary) => void;
  /** Refresh metadata for a queued item (e.g. once the backend resolved its title). */
  update: (video: VideoSummary) => void;
  enqueue: (video: VideoSummary) => void;
  remove: (ref: MediaRef) => void;
  clear: () => void;
  next: () => VideoSummary | null;
  previous: () => VideoSummary | null;
  setAutoplay: (on: boolean) => void;
  contains: (ref: MediaRef) => boolean;
}

const QueueContext = createContext<QueueValue | null>(null);

export function QueueProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<QueueState>(loadQueue);

  useEffect(() => {
    writeJson(QUEUE_KEY, state, window.sessionStorage);
  }, [state]);

  const playList = useCallback<QueueValue["playList"]>((items, start, meta = {}) => {
    const playable = items.filter((item) => item.available).slice(0, MAX_QUEUE);
    let index = playable.findIndex((item) => videoKey(item) === videoKey(start));
    if (index < 0) {
      playable.unshift(start);
      index = 0;
    }
    setState((s) => ({ ...s, items: playable, index, label: meta.label ?? null, listId: meta.listId ?? null }));
  }, []);

  const select = useCallback((video: VideoSummary) => {
    setState((s) => {
      const existing = s.items.findIndex((item) => videoKey(item) === videoKey(video));
      if (existing >= 0) return existing === s.index ? s : { ...s, index: existing };
      if (s.items.length === 0) return { ...s, items: [video], index: 0, label: null, listId: null };
      const at = s.index + 1;
      const items = [...s.items.slice(0, at), video, ...s.items.slice(at)].slice(0, MAX_QUEUE);
      return { ...s, items, index: at };
    });
  }, []);

  const update = useCallback((video: VideoSummary) => {
    setState((s) => {
      const i = s.items.findIndex((item) => videoKey(item) === videoKey(video));
      const current = s.items[i];
      if (i < 0 || !current || (current.title === video.title && current.channel?.name === video.channel?.name)) {
        return s;
      }
      const items = [...s.items];
      items[i] = { ...current, ...video };
      return { ...s, items };
    });
  }, []);

  const enqueue = useCallback((video: VideoSummary) => {
    setState((s) =>
      s.items.some((item) => videoKey(item) === videoKey(video))
        ? s
        : { ...s, items: [...s.items, video].slice(0, MAX_QUEUE) },
    );
  }, []);

  const remove = useCallback((ref: MediaRef) => {
    setState((s) => {
      const i = s.items.findIndex((item) => videoKey(item) === videoKey(ref));
      if (i < 0) return s;
      const items = s.items.filter((_, j) => j !== i);
      const index = i < s.index ? s.index - 1 : i === s.index ? Math.min(s.index, items.length - 1) : s.index;
      return { ...s, items, index: items.length ? index : -1 };
    });
  }, []);

  const clear = useCallback(() => setState((s) => ({ ...EMPTY, autoplay: s.autoplay })), []);
  const setAutoplay = useCallback((on: boolean) => setState((s) => ({ ...s, autoplay: on })), []);

  const value = useMemo<QueueValue>(() => {
    const keys = new Set(state.items.map(videoKey));
    const current = state.items[state.index] ?? null;
    return {
      ...state,
      current,
      hasNext: state.index + 1 < state.items.length,
      hasPrevious: state.index > 0,
      playList,
      select,
      update,
      enqueue,
      remove,
      clear,
      setAutoplay,
      contains: (ref) => keys.has(videoKey(ref)),
      next: () => {
        const item = state.items[state.index + 1] ?? null;
        if (item) setState((s) => ({ ...s, index: s.index + 1 }));
        return item;
      },
      previous: () => {
        const item = state.index > 0 ? (state.items[state.index - 1] ?? null) : null;
        if (item) setState((s) => ({ ...s, index: s.index - 1 }));
        return item;
      },
    };
  }, [state, playList, select, update, enqueue, remove, clear, setAutoplay]);

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useQueue(): QueueValue {
  const value = useContext(QueueContext);
  if (!value) throw new Error("useQueue must be used inside <QueueProvider>");
  return value;
}
