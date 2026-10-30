"""Recently added TV: several new episodes of a season show as the season, as Plex's own apps do."""

from __future__ import annotations

from app.apps.plex.library import group_recent


def episode(key: int, season: int, number: int, *, show: str = "5", show_title: str = "The Office (US)",
            season_thumb: bool = True, watched: bool = False) -> dict:
    season_key = f"{show}{season:02d}"
    return {
        "ratingKey": str(key), "type": "episode", "title": f"Episode {number}", "index": number, "parentIndex": season,
        "parentRatingKey": season_key, "parentTitle": f"Season {season}", "grandparentRatingKey": show,
        "grandparentTitle": show_title, "thumb": f"/library/metadata/{key}/thumb/1",
        **({"parentThumb": f"/library/metadata/{season_key}/thumb/1"} if season_thumb else {}),
        "grandparentThumb": f"/library/metadata/{show}/thumb/1", "grandparentArt": f"/library/metadata/{show}/art/1",
        "librarySectionTitle": "TV Shows", **({"viewCount": 1} if watched else {}),
    }


def test_many_episodes_of_one_season_become_the_season():
    cards = group_recent([episode(100 + n, 6, n, watched=n < 3) for n in range(1, 10)])
    assert len(cards) == 1
    card = cards[0]
    assert (card.type, card.key, card.title, card.show_title, card.season, card.new_episodes) == (
        "season", "506", "Season 6", "The Office (US)", 6, 9)
    assert card.poster == "/api/apps/plex/image?path=%2Flibrary%2Fmetadata%2F506%2Fthumb%2F1&w=300&h=450"
    assert card.watched is False  # only some of them were watched


def test_a_season_without_its_own_poster_uses_the_shows():
    cards = group_recent([episode(1, 2, 1, season_thumb=False), episode(2, 2, 2, season_thumb=False)])
    assert cards[0].poster == "/api/apps/plex/image?path=%2Flibrary%2Fmetadata%2F5%2Fthumb%2F1&w=300&h=450"


def test_each_season_of_a_show_gets_its_own_card():
    cards = group_recent([episode(1, 6, 1), episode(2, 5, 22), episode(3, 6, 2), episode(4, 5, 21)])
    assert [(c.type, c.key, c.title, c.show_title, c.new_episodes) for c in cards] == [
        ("season", "506", "Season 6", "The Office (US)", 2), ("season", "505", "Season 5", "The Office (US)", 2)]


def test_a_lone_episode_stays_an_episode_and_order_follows_the_newest():
    movie = {"ratingKey": "9", "type": "movie", "title": "A Film", "thumb": "/library/metadata/9/thumb/1"}
    raws = [episode(1, 1, 3, show="7", show_title="Other Show"), movie,
            episode(2, 6, 1), episode(3, 6, 2), episode(4, 1, 2, show="7", show_title="Other Show")]
    cards = group_recent(raws)
    assert [(c.type, c.key, c.new_episodes) for c in cards] == [("season", "701", 2), ("movie", "9", None),
                                                                ("season", "506", 2)]
    single = group_recent([episode(1, 6, 4)])[0]
    assert (single.type, single.key, single.episode, single.new_episodes) == ("episode", "1", 4, None)


def test_rows_are_capped_and_watched_groups_say_so():
    raws = [episode(n, 1, 1, show=str(1000 + n), show_title=f"Show {n}") for n in range(30)]
    assert len(group_recent(raws)) == 24
    assert group_recent([episode(1, 6, 1, watched=True), episode(2, 6, 2, watched=True)])[0].watched is True
