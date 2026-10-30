import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RouterProvider } from "@/router/router";

import { itemLabel, itemTitle, type PlexItem } from "./api";
import { PosterCard } from "./components";

const base: PlexItem = {
  key: "506", type: "season", title: "Season 6", year: null, summary: null, duration_seconds: null,
  poster: "/api/apps/plex/image?path=season", still: null, art: null, view_offset_seconds: null, watched: false,
  show_title: "The Office (US)", season: 6, episode: null, child_count: null, library: "TV Shows",
};

afterEach(cleanup);

describe("recently added cards", () => {
  it("name a season of new episodes after its show, with the season and how many", () => {
    const season = { ...base, new_episodes: 9 };
    expect(itemTitle(season)).toBe("The Office (US)");
    expect(itemLabel(season)).toBe("Season 6 · 9 new episodes");
    render(<RouterProvider><PosterCard item={season} /></RouterProvider>);
    expect(screen.getByRole("link", { name: "The Office (US), Season 6 · 9 new episodes" })).toHaveAttribute("href", "/apps/plex/item/506");
    expect(screen.getByText("9 new")).toBeInTheDocument();
  });

  it("leave ordinary seasons alone", () => {
    expect(itemLabel({ ...base, new_episodes: 1 })).toBe("Season 6 · 1 new episode");
    expect(itemTitle(base)).toBe("Season 6");
    expect(itemLabel({ ...base, child_count: 26 })).toBe("26 episodes");
  });
});
