import { Search } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/router/router";

import { plexApi, plexPath, type PlexItem } from "./api";
import { Failure, Grid, Loading, Row } from "./components";
import { useLoad } from "./useLoad";

export function SearchBox({ initial = "" }: { initial?: string }) {
  const { navigate } = useRouter();
  const [q, setQ] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (q.trim()) navigate(`${plexPath("search")}?${new URLSearchParams({ q: q.trim() })}`);
  };
  return (
    <form role="search" onSubmit={submit} className="flex max-w-md items-center gap-2">
      <input
        type="search"
        value={q}
        onChange={(event) => setQ(event.currentTarget.value)}
        placeholder="Search your Plex libraries"
        aria-label="Search your Plex libraries"
        className="h-9 min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-sm"
      />
      <Button type="submit" size="icon-sm" aria-label="Search Plex">
        <Search />
      </Button>
    </form>
  );
}

export function PlexHomeView() {
  const { data, error, retry } = useLoad((signal) => plexApi.home(signal), []);
  const libraries = useLoad((signal) => plexApi.libraries(signal), []);
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2">
        {libraries.data?.map((library) => (
          <Button key={library.key} asChild size="sm">
            <Link to={plexPath("library", library.key)}>{library.title}</Link>
          </Button>
        ))}
      </div>
      {error ? (
        <Failure message={error} onRetry={retry} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <Row title="Continue watching" items={data.continue_watching} />
          {data.rows.map((row) => (
            <Row key={row.library.key} title={`Recently added in ${row.library.title}`} items={row.items} more={plexPath("library", row.library.key)} />
          ))}
          {data.continue_watching.length === 0 && data.rows.length === 0 && <p className="mt-8 text-muted-foreground">Your libraries are empty.</p>}
        </>
      )}
    </>
  );
}

const SORTS = [
  ["title", "Title"],
  ["added", "Recently added"],
  ["year", "Year"],
] as const;

export function PlexLibraryView({ libraryKey }: { libraryKey: string }) {
  const [sort, setSort] = useState<string>("title");
  const [extra, setExtra] = useState<{ items: PlexItem[]; loading: boolean }>({ items: [], loading: false });
  const libraries = useLoad((signal) => plexApi.libraries(signal), []);
  const first = useLoad((signal) => {
    setExtra({ items: [], loading: false });
    return plexApi.libraryItems(libraryKey, 0, sort, signal);
  }, [libraryKey, sort]);
  const library = libraries.data?.find((candidate) => candidate.key === libraryKey);
  const items = [...(first.data?.items ?? []), ...extra.items];
  const more = first.data ? items.length < first.data.total : false;

  const loadMore = () => {
    setExtra((state) => ({ ...state, loading: true }));
    plexApi.libraryItems(libraryKey, items.length, sort).then(
      (page) => setExtra((state) => ({ items: [...state.items, ...page.items], loading: false })),
      () => setExtra((state) => ({ ...state, loading: false })),
    );
  };

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">{library?.title ?? "Library"}</h2>
        <label className="flex items-center gap-2 text-sm">
          Sort by
          <select value={sort} onChange={(event) => setSort(event.currentTarget.value)} className="rounded-md border border-border bg-background px-2 py-1">
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-4">
        {first.error ? <Failure message={first.error} onRetry={first.retry} /> : !first.data ? <Loading /> : <Grid items={items} />}
      </div>
      {more && (
        <Button className="mt-6" onClick={loadMore} disabled={extra.loading}>
          {extra.loading ? "Loading…" : "Load more"}
        </Button>
      )}
    </>
  );
}

export function PlexSearchView({ q }: { q: string }) {
  const { data, error, retry } = useLoad((signal) => plexApi.search(q, signal), [q]);
  return (
    <>
      <h2 className="mt-6 text-2xl font-bold">Results for “{q}”</h2>
      <div className="mt-4">
        {error ? <Failure message={error} onRetry={retry} /> : !data ? <Loading /> : data.length === 0 ? <p className="text-muted-foreground">Nothing found.</p> : <Grid items={data} />}
      </div>
    </>
  );
}
