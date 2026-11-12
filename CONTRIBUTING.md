# Contributing

## Setup

```bash
npm ci
cp .env.example .env   # set CONFIG_SECRET, PUBLIC_BASE_URL and ADMIN_PASSWORD
npm run dev            # http://localhost:7000/configure
```

Sync needs `ffmpeg` and `ffprobe` on your PATH, and an AIOStreams install URL from an instance in `OWN_AIOSTREAMS` or `ALLOWED_AIOSTREAMS`.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

The same checks run on every push and pull request, and the tests also run during the Docker build.

For changes to sync or matching, run the replay check against a server's cache as well. It shows which past plays a change would decide differently:

```bash
REPLAY_HOST=<ssh host> npm run replay
```

See `scripts/replay.ts` and [docs/how-it-works.md](docs/how-it-works.md).

## Layout

| Path | What it does |
|---|---|
| `src/server.ts` | Start-up: checks the required settings, starts the server |
| `src/app.ts` | Routes: manifest, subtitle lists, downloads, dashboard |
| `src/access.ts` | Sign-in for the configure page and dashboard, rate limits |
| `src/profile.ts` | Per-link settings, encrypted into the link |
| `src/configure.ts`, `src/page.ts` | The configure page: checks and HTML |
| `src/sources.ts`, `src/subsource.ts`, `src/downloads.ts` | Subtitle sources, downloads and unpacking |
| `src/thesubtitledb.ts`, `src/gestdown.ts`, `src/animetosho.ts` | The sources that need no key: TheSubtitleDB, Gestdown (Addic7ed's TV subtitles) and Anime Tosho (dub captions from anime releases' own tracks) |
| `src/cinemeta.ts` | A title's name, year, TVDB id, genres and country from Cinemeta, shared by the sources (and whether it is anime) |
| `src/matching.ts`, `src/quality.ts` | Episode matching and ranking |
| `src/sync.ts`, `src/mkv.ts`, `src/vad.ts` | Reading the playing file and retiming subtitles |
| `src/reads.ts` | Pausing reads when the file's host refuses, and the daily read limit |
| `src/stats.ts`, `src/statsPage.ts` | Dashboard numbers and HTML |
| `src/ui.ts` | Styles and icons shared by the pages |
| `test/` | Vitest tests |
| `scripts/` | Replay check and speech-detector evaluation |

## Rules

- Never put API keys, passwords or real install URLs in code, tests or logs. Tests use made-up values.
- Anything a user or a third party controls (subtitle files, addon URLs, archives) is untrusted: keep fetches to public https hosts (`src/net.ts`) and keep size limits in place.
- Add or update tests for any change in behaviour.
- When the sync method changes in a way that makes old results wrong, bump `SYNC_VERSION` in `src/sync.ts`.
- Work on a branch and open a pull request against `main`.
- Contributions are licensed under the project's license, [AGPL-3.0](LICENSE).
