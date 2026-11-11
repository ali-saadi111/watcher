# Slide Watcher

Watches Stake.com's [Slide](https://stake.com/casino/games/slide) game live, records every round
multiplier, and learns/verifies the game's statistical behavior: distribution vs theory,
streaks, Markov transitions, gap analysis, hot/cold rolling stats, and CUSUM drift detection.

## How it works

- `watcher.js` runs a persistent Chrome context on the Slide page (passes Kasada/Cloudflare),
  installs an in-page MutationObserver that records every round as the game reel updates,
  dedupes the paired tile rendering, and appends one JSON record per round to `data/rounds.jsonl`.
- Auto-reloads on stale feed (>5 min without a round). Auto-runs the analyzer every 25 rounds.
- `analyze.js` reads the log and writes `data/report.md` + `data/analysis.json`.

> Round outcomes are provably fair and independent — the watcher verifies and describes behavior,
> it cannot predict outcomes. Game EV is −2% before rakeback.

## Setup (Linux server)

```bash
git clone https://github.com/ali-saadi111/watcher.git
cd watcher
npm install
# Chromium/Chrome for the playwright-core channel:
npx playwright-core install chromium   # or install google-chrome system-wide
node watcher.js
```

By default the watcher launches a real Chrome window positioned offscreen (for desktop use).
On a headless Linux server, set environment variables:

```bash
HEADLESS=1 node watcher.js
```

`HEADLESS=1` launches Chromium headless. If Cloudflare/Kasada blocks headless (page stuck on
"Just a moment..."), install `xvfb` and run headed inside a virtual display instead:

```bash
sudo apt install -y xvfb chromium-browser
xvfb-run -a node watcher.js
```

## Files

| Path | Purpose |
|---|---|
| `watcher.js` | capture process (browser + observer + logger) |
| `analyze.js` | statistics: distribution, streaks, Markov, gaps, CUSUM drift |
| `data/rounds.jsonl` | one line per round: `{"ts": "...", "multiplier": 2.86}` |
| `rounds.jsonl` | seeded history: 1,915 rounds observed Nov 11 2026 (01:50–13:14 UTC) |
| `data/report.md` | generated pattern report |
| `data/status.json` | live status (rounds, last round, reloads) |

To start with the seeded history on the server:

```bash
mkdir -p data && cp rounds.jsonl data/rounds.jsonl
node analyze.js   # generates the full report from 1,915 rounds immediately
```

## Run as a systemd service (auto-restart, survives logout)

```bash
sudo cp deploy/slide-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now slide-watcher
journalctl -u slide-watcher -f        # follow logs
```

## Report sample

See `data/report.md` after ~25 rounds. Key outputs: chi-square goodness-of-fit vs theory,
longest low/high streaks (empirical martingale-killer evidence), average gap between ≥10× /
≥50× rounds, Bayesian P(≥2×) posterior, CUSUM drift alarm.
