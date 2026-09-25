# OBS → C1: VATUSA progression dashboard

A static dashboard showing how long VATUSA controllers take to go from **OBS** to **C1**.
It has no backend: each visit fetches the home rosters for every active ARTCC straight from the
public [VATUSA API](https://api.vatusa.net/v2) in the browser, so the numbers are always current.
Results are cached in the visitor's browser for one hour. The **Refresh data** button skips the cache.

Styled with [Primer CSS](https://primer.style/css) 21.5.1, the last release that still includes
the Box, Label and flash components. It follows the system light/dark setting, and the header
button switches it manually.

## Method

- Rosters: `GET /v2/facility` → `GET /v2/facility/<id>/roster/home` for each active ARTCC.
- Kept: current rating ≥ C1 (C1, C3, I1, I3, SUP, ADM).
- Duration: first `S3→C1` promotion date minus first `OBS→S1` promotion date.
- Omitted: controllers missing either promotion (typically transfers or incomplete legacy records).
- Stage by stage: S1→S2, S2→S3 and S3→C1 are measured between consecutive first promotions for
  **every** home controller who completed that stage (any current rating), with a facility × stage median table.
- Compare: enter a CID or name to compare each stage with the facility and division. Stages still
  in progress show the time so far, and stages with no record are listed as such. Link straight to a
  comparison with `#cid=<CID>`.
- Compare covers every home controller, at any rating (C1+ also get their rating ladder and OBS→C1 rank). A CID that isn't on any home roster is looked up
  with `GET /v2/user/<cid>`. The public API returns no promotion history for those members, so the
  page shows what exists and says there's nothing to compare.
- Members with name privacy enabled are shown by CID only.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | Page layout (Primer classes) |
| `assets/vatusa.js` | API fetching and statistics (no DOM, runs in Node too) |
| `assets/app.js` | Rendering, search, CSV export, theme toggle, caching |
| `assets/app.css` | Charts and grids that Primer doesn't cover |

## Run locally

ES modules need an HTTP server (opening the file directly won't work):

```sh
python -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set Source to **Deploy from a branch**, then pick `main` and `/ (root)`.
4. The site will be published at `https://<user>.github.io/<repo>/`.

Nothing needs rebuilding when the data changes, because the page pulls it live.

Not affiliated with VATSIM or VATUSA.
