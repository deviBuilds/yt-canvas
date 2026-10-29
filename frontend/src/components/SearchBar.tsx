import { Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Tip } from "@/components/ui/tooltip";

import { ApiError } from "../api/http";
import { discoveryApi } from "../discovery/api";
import { channelPath, playlistPath, searchPath, useRouter, watchPath } from "../router/router";

export function SearchBar() {
  const { path, params, navigate } = useRouter();
  const currentQuery = path === "/search" ? (params.get("q") ?? "") : "";
  const [value, setValue] = useState(currentQuery);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(currentQuery);
  }, [currentQuery]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const input = value.trim();
    if (!input) return;
    setError(null);
    setPending(true);
    try {
      const parsed = await discoveryApi.resolve(input);
      switch (parsed.kind) {
        case "video":
          navigate(watchPath({ source: "youtube", id: parsed.video_id! }, { list: parsed.playlist_id, t: parsed.start_seconds }));
          break;
        case "playlist":
          navigate(playlistPath(parsed.playlist_id!));
          break;
        case "channel":
          navigate(channelPath(parsed.channel_ref!));
          break;
        default:
          navigate(searchPath(parsed.query ?? input));
      }
      inputRef.current?.blur();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That input could not be understood.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="relative flex min-w-0 max-w-[728px] flex-1 items-center" role="search" onSubmit={submit}>
      <label className="sr-only" htmlFor={`${errorId}-input`}>
        Search YouTube or paste a URL
      </label>
      <div className="flex h-10 min-w-0 flex-1 items-center rounded-l-full border border-input-border bg-input-bg pl-4 pr-1 focus-within:ml-0 focus-within:border-link focus-within:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]">
        <input
          ref={inputRef}
          id={`${errorId}-input`}
          type="search"
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          placeholder="Search or paste a YouTube link"
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          maxLength={500}
        />
        {value ? (
          <button
            type="button"
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-secondary"
            aria-label="Clear search"
            onClick={() => {
              setValue("");
              setError(null);
              inputRef.current?.focus();
            }}
          >
            <X className="size-5" />
          </button>
        ) : null}
      </div>
      <Tip label="Search">
        <button
          type="submit"
          className="flex h-10 w-12 shrink-0 cursor-pointer items-center justify-center rounded-r-full border border-l-0 border-input-border bg-search-button hover:bg-secondary-hover sm:w-16"
          aria-label="Search"
          disabled={pending}
        >
          {pending ? <span className="spinner small" /> : <Search className="size-5" strokeWidth={1.75} />}
        </button>
      </Tip>
      {error ? (
        <p
          id={errorId}
          className="absolute left-0 top-full z-50 mt-2 max-w-full rounded-lg bg-popover px-3 py-2 text-sm text-danger shadow-lg"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
