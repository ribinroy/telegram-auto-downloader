# GoPublic.md — Taking DownLee Public

Findings from two research passes (June 2026): a repo audit for public-release blockers,
and research into how self-hosted projects reach the homelab community.

**Verdict: yes — dockerize and go public.** The git history is clean of secrets (no rewrite
required), the audience for exactly this kind of app is large and reachable, and the riskiest
packaging problem for Telegram apps (interactive first-run login) is already solved by the
web-based login flow. There is a short must-fix list first.

---

## 1. Must-fix before flipping the repo public

Severity-ordered, from the repo audit:

### High — personal/network data in tracked files

- [ ] **Re-take README screenshots** with sanitized file names (visible file names matter
  for positioning — see §4). The orphaned personal screenshots are already deleted.

### Low — polish

- [ ] Delete the accidental tracked file `=0.19.0` (pip console output).
- [ ] Fix `requirements.txt`: remove stdlib `asyncio`/`pathlib` (the PyPI `pathlib`
  backport can break installs), add the missing `PyJWT`, document `yt-dlp` and
  `playwright` as extras. A fresh `pip install -r requirements.txt` currently can't run
  the app.
- [ ] `telegram_downloader.service` hardcodes `User=hs` and `/home/hs/...` — template it
  or drop it once Docker is the primary install path.
- [ ] Git author on all 238 commits is the personal Gmail + real name. Only fixable via
  history rewrite; most maintainers accept this. (See §2 for the rewrite trade-off.)

## 2. Git history verdict: clean — no rewrite required

Audited every file ever added plus pickaxe sweeps for credential strings:

- `.env`, `*.session`, `cookies.txt`, `downloads.json` — **never committed**; `.gitignore`
  covered them from the initial commit.
- No real API hash, chat ID, or DB connection string ever appears — placeholders only.
- What *does* live in history: the LAN IP (several commits), one deleted personal
  screenshot (`screenshots/Telegram.png`), an accidental `node_modules/` commit (bloat),
  and the author name/email on every commit.

Options: (a) fix HEAD and publish with history as-is — acceptable; (b) one-time
`git filter-repo` to drop the IP/screenshot/bloat; (c) zero-effort alternative: publish a
fresh single-commit repo. The audit's view: fixing HEAD is what actually matters.

## 3. Dockerization — effectively mandatory, and what it requires

For this community, "bare-metal systemd + venv + your own Postgres" is a non-starter for
~90% of potential users. A compose file is also literally the submission format for the
CasaOS/Umbrel/Runtipi app stores and the basis of Unraid templates.

**Target packaging:**

- `docker-compose.yml` bundling the app + PostgreSQL, named volumes, env config,
  one-command quick start.
- Multi-arch images (`linux/amd64` + `linux/arm64`) built by GitHub Actions (Buildx),
  published to **GHCR as primary** (no pull limits) with a Docker Hub mirror
  (discoverability; Unraid/CasaOS users search it). Tags: `latest` + semver from releases.

**Code changes needed (found in the audit):**

- `yt-dlp` path is hardcoded to `<repo>/venv/bin/yt-dlp` (`backend/ytdlp_handler/__init__.py:24`)
  and the self-upgrade endpoint shells to `<repo>/venv/bin/pip` — make binary paths
  configurable / PATH-resolved.
- Image needs: `ffmpeg`/`ffprobe`, `yt-dlp`, Node.js (yt-dlp's JS runtime for YouTube),
  optionally Playwright + Chromium (~400 MB — consider a separate `-full` image tag).
- Volumes: downloads dir, thumbnails, Telethon session file, `cookies.txt`, logs. Session
  path and cookies path should become env-configurable (currently repo-root relative).
- **Bot queries in a container**: `lsblk`/`smartctl`/`sensors`/`df` won't see host hardware.
  Ship container-aware default queries (the DB-backed ones — queue/failed/recent — work
  fine), document host-mount/privileged options for hardware queries, or note the feature
  works best on bare metal.
- Already container-friendly: `WEB_HOST=0.0.0.0` default, plain `python main.py`
  entrypoint, threading-mode SocketIO, external Postgres via env URL, and the web-based
  Telegram login (no interactive terminal needed — the classic Docker killer for
  Telethon apps is already solved).

## 4. Positioning & risk

- **GitHub takedown risk: low.** Precedent is favorable (youtube-dl reinstated in 2020 +
  GitHub's $1M defense fund; yt-dlp, MeTube, Pinchflat, Tube Archivist, telegram-files all
  live openly). The rule is neutral framing: a *"media download manager"* — never name
  specific channels, no infringing file names in screenshots, a short "download content
  you have the right to download" disclaimer. Keep "Telegram" out of the project name —
  "DownLee" is fine.
- **The real risk is Telegram-side**: user-session automation can get accounts banned
  (fresh accounts especially). README must warn: use your own API ID/hash, prefer an aged
  account or a bot token (DownLee supports both login modes). Expect this to be the
  most-asked launch-thread question.
- **"Why another downloader?"** — reviewers will ask. The differentiators vs
  MeTube/Pinchflat/telegram-files: multi-source (Telegram channels + yt-dlp + seedbox
  SFTP + magnet handoff) in one dashboard, real-time progress, bot chat commands, VR
  player. Put a comparison note in the README.

## 5. Launch playbook (prioritized)

| When | Channel | Notes |
|------|---------|-------|
| Launch day | **r/selfhosted** | Highest-leverage channel (~650k weekly visitors). "I built X, feedback welcome", screenshots inline, disclose authorship, answer every comment for the first 2 hours. |
| Launch week | **selfh.st (Self-Host Weekly)** | Open submission form; features ~19 new apps/week. |
| +1–2 weeks | **Show HN** | Tue–Thu ~14:00–17:00 UTC; only after the compose quick start exists. Be present in the thread. |
| +1–3 months | **Unraid Community Apps** | Needs Docker image + template XML + a dedicated Unraid forum support thread. NAS crowd loves *arr-style download tools. |
| +1–3 months | **Runtipi / CasaOS / Umbrel stores** | All compose-based PRs; cheap once compose exists. Umbrel requires image digests. |
| +4 months | **awesome-selfhosted** | Hard rule: first release must be **4+ months old**; needs the FOSS license. File early, it'll wait tagged "needs to mature". |
| Outcome, not a step | linuxserver.io | They adopt already-popular apps themselves. |

**Table stakes the successful launches share:** polished README with hero screenshot +
60–90s demo GIF (beats a live demo for an app needing Telegram credentials), one-command
Docker install, semver releases with changelogs, CI badge, and fast issue responses in the
first weeks.

## 6. Suggested order of work

1. Fix the High items (§1) + set `JWT_SECRET` in prod + add LICENSE. *(blocker for everything)*
2. Dockerfile + compose + multi-arch CI to GHCR; make yt-dlp/session/cookies paths
   configurable; forced first-run password; container-aware default queries.
3. README rewrite: pitch, sanitized screenshots/GIF, compose quick start, Telegram
   credential walkthrough, ban-risk + content disclaimers, security notes, comparison
   section.
4. Tag `v1.0.0`, flip public, submit selfh.st, post r/selfhosted.
5. Show HN, then the app-store PRs and Unraid template.
6. Month 4: awesome-selfhosted PR.
