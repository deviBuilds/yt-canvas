import { Mic, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { ApiError } from "../api/http";
import { discoveryApi } from "../discovery/api";
import { channelPath, playlistPath, searchPath, useRouter, watchPath } from "../router/router";

// The Web Speech API is still prefixed in Chromium and Safari and missing in Firefox.
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** YouTube's round mic button: dictate a search, then run it. Hidden where the browser can't do speech. */
function VoiceSearch({ onTranscript, onFinal, onError }: { onTranscript: (text: string) => void; onFinal: (text: string) => void; onError: (message: string) => void }) {
  const [listening, setListening] = useState(false);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const Recognition = recognitionConstructor();
  useEffect(() => () => recognition.current?.stop(), []);
  if (!Recognition) return null;

  const toggle = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const r = new Recognition();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.onresult = (event) => {
      const results = Array.from(event.results);
      const text = results.map((result) => result[0]?.transcript ?? "").join("").trim();
      onTranscript(text);
      if (results.at(-1)?.isFinal && text) onFinal(text);
    };
    r.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") onError(`Voice search didn't work (${event.error}).`);
    };
    r.onend = () => setListening(false);
    recognition.current = r;
    setListening(true);
    r.start();
  };

  return (
    <Tip label={listening ? "Stop listening" : "Search with your voice"}>
      <button
        type="button"
        aria-label={listening ? "Stop listening" : "Search with your voice"}
        aria-pressed={listening}
        onClick={toggle}
        className={cn(
          "ml-3 flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-secondary hover:bg-secondary-hover",
          listening && "animate-pulse bg-brand text-white hover:bg-brand",
        )}
      >
        <Mic className="size-6" strokeWidth={1.75} />
      </button>
    </Tip>
  );
}

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

  const run = async (raw: string) => {
    const input = raw.trim();
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(value);
  };

  return (
    // Signed-in YouTube: one rounded 48 px pill with the search button inside, 40 px in from the logo.
    <form className="group relative flex min-w-0 max-w-[724px] flex-1 items-center sm:pl-10 sm:focus-within:pl-0" role="search" onSubmit={submit}>
      <label className="sr-only" htmlFor={`${errorId}-input`}>
        Search YouTube or paste a URL
      </label>
      <div className="flex h-10 min-w-0 flex-1 items-center rounded-full border border-input-border bg-input-bg pl-4 pr-1 focus-within:border-link focus-within:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] sm:h-12 sm:focus-within:pl-3">
        {/* YouTube shows a search icon inside the box while it has focus. */}
        <Search className="mr-3 hidden size-5 shrink-0 sm:group-focus-within:block" strokeWidth={1.75} aria-hidden="true" />
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
        <Tip label="Search">
          <button
            type="submit"
            className="ml-1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-secondary hover:bg-secondary-hover sm:size-10"
            aria-label="Search"
            disabled={pending}
          >
            {pending ? <span className="spinner small" /> : <Search className="size-5 sm:size-6" strokeWidth={1.75} />}
          </button>
        </Tip>
      </div>
      <VoiceSearch
        onTranscript={setValue}
        onFinal={(text) => void run(text)}
        onError={(message) => setError(message)}
      />
      {error ? (
        <p
          id={errorId}
          className="absolute left-0 top-full z-50 mt-2 max-w-full rounded-lg bg-popover px-3 py-2 text-sm text-danger shadow-lg sm:left-10"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
