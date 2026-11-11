# AIOSubtitles

A self-hosted Stremio subtitle addon for [AIOStreams](https://github.com/Viren070/AIOStreams). It finds subtitles for the episode you're playing and retimes each one to your exact file. It was made for anime watched in English dub, and works for any movie or series.

## Features

- **Several sources:** SubSource, SubDL, OpenSubtitles (no key needed), Subtitle Cat (off unless turned on, no key needed) and up to 3 other Stremio subtitle addons. All results are ranked together and the best one wins.
- **English Dub captions:** subtitles transcribed from the English dub, so the words match the voices. Falls back to official English closed captions when no dub captions exist.
- **Regular English too:** for watching in the original language, regular English subtitles timed to the original voices, as a separate choice.
- **Other languages:** the best subtitle per language, official translations first, machine translations left out unless you allow them, and ranked below every other subtitle when you do.
- **Synced to your file:** reads the timing of the playing file's own subtitles (for most .mkv files from its index, about 1 MB; otherwise a few short stretches) and shifts each subtitle to match. Handles timing that changes mid-episode, subtitles made for another frame rate, subtitles timed by hand to another recording (timed line by line from the file's own subtitles), and files with no subtitles (timed by speech in the audio).
- **Per-person settings:** each person makes their own link with their own keys. Settings are encrypted into the link; nothing about them is stored in plain text on the server.
- **Dashboard:** usage, API limits per key, errors and recent activity.

## Requirements

- Docker with Compose.
- An AIOStreams install for each person: your own or a public instance. It's required, because sync uses it to find the file being played.
- An address AIOStreams and your players can reach. Use https behind a reverse proxy if Stremio apps will use it; Stremio's web app only loads https subtitles.
- A [SubSource](https://subsource.net/api) or [SubDL](https://subdl.com/panel/api) API key per person, or OpenSubtitles (no key).

Resource use is small: about 30 MB of memory idle. A new .mkv episode is usually read from its index: about 1 MB and a second. Other files cost about 10 s of CPU and roughly 14% of the file.

## Installation

```bash
git clone https://github.com/jager-gg/AIOSubtitles.git
cd AIOSubtitles
cp .env.example .env
cp docker-compose.example.yml docker-compose.yml
```

Edit `.env`:

```bash
CONFIG_SECRET=        # openssl rand -hex 32
PUBLIC_BASE_URL=https://subs.example.com
OWN_AIOSTREAMS=https://aiostreams.example.com
ADMIN_PASSWORD=       # required, for the dashboard
ADDON_PASSWORD=       # optional, for /configure
```

Start it:

```bash
docker compose up -d --build
```

The tests run during the build, so a broken build never starts. Then open `<PUBLIC_BASE_URL>/configure`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CONFIG_SECRET` | required | Encrypts each person's settings into their link. 32+ characters. Changing it breaks every link |
| `PUBLIC_BASE_URL` | required | The addon's address as AIOStreams and players reach it, without a trailing slash |
| `OWN_AIOSTREAMS` | unset | Your AIOStreams' public address. Install URLs from it are accepted for sync |
| `AIOSTREAMS_BASE` | `OWN_AIOSTREAMS` | Where this container reaches your AIOStreams, if not at its public address (for example `http://aiostreams:3000` on a shared Docker network) |
| `ALLOWED_AIOSTREAMS` | public instances | Other AIOStreams instances accepted, as comma-separated origins. Set it to your own to accept only that one |
| `ADMIN_PASSWORD` | required | Password for the dashboard (8+ characters). It opens the configure page too |
| `ADDON_PASSWORD` | unset (open) | Password for the configure page, where people make and edit links |
| `TIME_ZONE` | `UTC` | Time zone the dashboard shows times in (an IANA name) |
| `DAILY_READ_GB` | `50` | Most GB read from the files being played in a day (UTC), over everyone. Once it's spent, new files are listed unsynced until the next day. `0` for no limit |
| `RESULT_CACHE_TTL_SECONDS` | `21600` | How long subtitle search results are cached |
| `PORT` | `7000` | Port inside the container |

### Exposing it

| Path | Used by | Protect it |
|---|---|---|
| `/manifest.json`, `/<link>/manifest.json`, `/<link>/subtitles/…`, `/<link>/download/…`, `/logo.png` | AIOStreams and players | No. These must stay open. Links are long encrypted tokens and can't be guessed |
| `/configure`, `/<link>/configure` | people making or editing a link | Yes, with `ADDON_PASSWORD` or your proxy's login |
| `/stats` | you | Always, with `ADMIN_PASSWORD`. It shows what was played |

Signing in keeps you signed in for 30 days. After 5 wrong passwords from one address, it waits 15 minutes. A reverse proxy is trusted for the visitor's address only when it runs on the same machine or a private network.

With an SSO proxy (Pangolin, Authelia and the like), you can leave `ADDON_PASSWORD` unset: let the addon paths bypass the login and keep it on everything else.

To keep it off the internet, run it on the same Docker network as AIOStreams and set `PUBLIC_BASE_URL=http://aiosubtitles:7000`. This works for players that fetch subtitles through a server (such as AIOMetadata in Jellyfin), not for Stremio apps.

## Usage

1. Open `/configure`.
2. **Connect AIOStreams:** paste your AIOStreams install URL (in AIOStreams: **Save & install**, then copy it).
3. **Choose your sources:** a SubSource or SubDL key, OpenSubtitles, Subtitle Cat, and/or other subtitle addons by manifest URL. Subtitle Cat finds uploads the other sites lack, such as fan translations, by name only, so one of its subtitles is listed only once it has synced to the playing file.
4. **Pick your languages:** **English Dub** gives captions written from the English dub, for watching dubbed. **English** gives regular subtitles, for watching in the original language. Every other language gets its best subtitle.
5. **Set your filters:** machine translations, hearing-impaired subtitles, and the switches below.
6. **Create your link**, then in AIOStreams: **Add addon → Custom**, paste the link as the manifest URL, resources: Subtitles.

To change settings later, click **Reconfigure** on AIOSubtitles in AIOStreams. Saved keys are kept unless replaced, and the link stays the same.

| Switch | Off | On |
|---|---|---|
| Skip languages the file already has | Lists every language | Leaves out languages the file has its own full subtitles for (English Dub is always listed) |
| Only subtitles that sync | Lists subtitles that can't be synced, marked as not synced | Leaves them out |
| Status in the track name | Tracks are named by language ("Arabic"), with the status in the description | "Arabic (Synced)", for players that show only the name |

To share the server, give people `<PUBLIC_BASE_URL>/configure`, and the `ADDON_PASSWORD` if you set one. Each person uses their own keys and their own AIOStreams.

## Dashboard

`/stats` needs `ADMIN_PASSWORD` and shows:

- CPU, memory, data read and cache size, today and per day.
- Each SubSource and SubDL key against its free plan (keys show as short hashes, never in full).
- Each link's use over the last 7 days.
- Recent errors and recent activity, including file names.

## Backups and updates

- Back up `CONFIG_SECRET`. Without it, every link stops working.
- Back up `links/` in the `aiosubtitles-cache` volume: settings edited from the configure page are stored there. `stats/` holds the dashboard history; everything else rebuilds itself.

  ```bash
  docker run --rm -v aiosubtitles-cache:/c -v "$PWD":/out alpine tar -czf /out/aiosubtitles-backup.tgz -C /c links stats
  ```

- Update with `git pull && docker compose up -d --build`. If the build fails, the running container keeps running.

## Troubleshooting

- **Subtitles show as not synced:** check `docker compose logs`. `no stream in AIOStreams named …` means the file you played wasn't in your AIOStreams list, usually because a usenet release was dead and AIOStreams fell back to another file. The player still reports the first file's name, so the real one can't be found.
- **`the file's host refused reads` in the logs:** the debrid or usenet host answered 429, or 403 three times in a row. Reads from that host pause for 5 minutes (doubling up to an hour if it keeps refusing) and subtitles are listed unsynced meanwhile.
- **Changes don't show up:** AIOStreams caches subtitle lists. Clear its `subtitles` cache, and if you use AIOMetadata, restart it (it caches them for an hour).

## Development

```bash
npm ci
npm test
npm run typecheck
npm run dev        # needs a .env
```

How matching, ranking and sync work is described in [docs/how-it-works.md](docs/how-it-works.md). See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Credits

- Built for [AIOStreams](https://github.com/Viren070/AIOStreams) by Viren070, which it uses to find the file being played.
- Speech detection by [Silero VAD](https://github.com/snakers4/silero-vad) (MIT).

## License

[AGPL-3.0](LICENSE). Bundled third-party files: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
