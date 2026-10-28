import { useEffect, useId, useState, type FormEvent } from "react";

import { ApiError } from "../api/http";
import { discoveryApi } from "../discovery/api";
import { channelPath, playlistPath, searchPath, useRouter, watchPath } from "../router/router";
import { Icon } from "./Icon";

export function SearchBar() {
  const { path, params, navigate } = useRouter();
  const currentQuery = path === "/search" ? (params.get("q") ?? "") : "";
  const [value, setValue] = useState(currentQuery);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errorId = useId();

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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That input could not be understood.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="search" role="search" onSubmit={submit}>
      <label className="sr-only" htmlFor={`${errorId}-input`}>
        Search YouTube or paste a URL
      </label>
      <input
        id={`${errorId}-input`}
        type="search"
        className="search-input"
        placeholder="Search, or paste a YouTube video, channel or playlist URL"
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
      <button type="submit" className="search-button" aria-label="Search" disabled={pending}>
        {pending ? <span className="spinner small" /> : <Icon name="search" />}
      </button>
      {error ? (
        <p id={errorId} className="search-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
