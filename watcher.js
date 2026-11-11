// Slide round watcher — Stake.com/casino/games/slide
// Runs a real (offscreen-positioned) Chrome window that passes Kasada/Cloudflare,
// installs an in-page MutationObserver that records every round result the moment
// the game reel updates, drains those events, dedupes them, and appends one record
// per round to data/rounds.jsonl. Runs analyze.js every REPORT_EVERY new rounds.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const DATA = path.join(BASE, 'data');
const LOG = path.join(DATA, 'rounds.jsonl');
const STATUS = path.join(DATA, 'status.json');
const PROFILE = path.join(BASE, 'chrome-profile');
const URL = 'https://stake.com/casino/games/slide';
const DRAIN_MS = 5000;      // drain interval
const STALE_MS = 300000;    // reload if no new round for 5 min
const REPORT_EVERY = 25;    // run analyzer every N new rounds

fs.mkdirSync(DATA, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);
const writeStatus = s => { try { fs.writeFileSync(STATUS, JSON.stringify(s, null, 2)); } catch {} };

const INSTALL_OBSERVER = () => {
  // Records every round result text appearing in the game reel (newest tile first).
  window.__rounds = [];
  const arm = () => {
    const track = document.querySelector('.track');
    if (!track) { setTimeout(arm, 1000); return; }
    const grab = () => Array.from(track.querySelectorAll('.tile .multiplier span'))
      .map(s => s.textContent.trim());
    let last = JSON.stringify(grab());
    new MutationObserver(() => {
      const cur = grab();
      const s = JSON.stringify(cur);
      if (s !== last) {
        last = s;
        const vals = cur.map(t => parseFloat(t));
        // record new head values that are real results (skip 0.00 placeholders)
        const head = vals.filter(Number.isFinite);
        if (head.length && head[0] > 0) window.__rounds.push({ at: Date.now(), reel: head });
      }
    }).observe(track, { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm); else arm();
};

const drain = async (page) => page.evaluate(() => {
  const out = window.__rounds || [];
  window.__rounds = [];
  return out;
});

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: process.env.CHANNEL || 'chrome',
    headless: process.env.HEADLESS === '1',
    viewport: { width: 1400, height: 900 },
    ignoreDefaultArgs: ['--enable-automation', '--disable-component-extensions-with-background-pages'],
    args: [
      ...(process.env.HEADLESS === '1' ? [] : ['--window-position=3000,3000']),
      '--window-size=1400,900', '--no-first-run',
      '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
  });
  const page = await ctx.newPage();
  await page.addInitScript(INSTALL_OBSERVER);

  let rounds = 0, reloads = 0, lastNewAt = Date.now(), lastHead = null, lastRecorded = null;

  async function load() {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log('goto error:', e.message.split('\n')[0]));
    for (let i = 0; i < 36; i++) {           // wait up to 3 min for the game to render
      await page.waitForTimeout(5000);
      const ok = await page.evaluate(() => !!document.querySelector('.track .tile'));
      if (ok) return;
    }
    throw new Error('game reel never rendered');
  }

  await load();
  // seed lastRecorded with the current head so we don't double-log the pre-load head
  try {
    const head = await page.evaluate(() => {
      const t = document.querySelector('.track');
      const v = t ? t.querySelector('.tile .multiplier span')?.textContent.trim() : null;
      return v ? parseFloat(v) : null;
    });
    if (head > 0) lastRecorded = head;
    log('seeded head:', lastRecorded);
  } catch {}
  log('page loaded, observer armed');
  writeStatus({ running: true, rounds, reloads, startedAt: new Date().toISOString() });

  const runAnalyzer = () => {
    try { spawn(process.execPath, [path.join(BASE, 'analyze.js')], { stdio: 'ignore', cwd: BASE }); }
    catch (e) { log('analyzer spawn failed:', e.message); }
  };

  for (;;) {
    await page.waitForTimeout(DRAIN_MS);
    try {
      const events = await drain(page);
      for (const ev of events) {
        // The reel renders each value as a duplicate pair: [new,new,prev,prev,...].
        // Unique tile values, newest first:
        const uniq = [];
        for (let i = 0; i < ev.reel.length; i += 2) {
          const v = ev.reel[i];
          if (Number.isFinite(v) && v > 0 && v !== uniq[0]) uniq.push(v);
        }
        const v = uniq[0];
        if (v && v !== lastRecorded) {
          lastRecorded = v;
          fs.appendFileSync(LOG, JSON.stringify({ ts: new Date(ev.at).toISOString(), multiplier: v }) + '\n');
          rounds++; lastNewAt = Date.now();
          log('round', v.toFixed(2) + 'x', '(total ' + rounds + ')');
        }
      }
      writeStatus({ running: true, rounds, reloads, lastRound: lastRecorded, lastRoundAt: new Date(lastNewAt).toISOString() });
      if (rounds > 0 && rounds % REPORT_EVERY === 0) { log('running analyzer at round', rounds); runAnalyzer(); }
      if (Date.now() - lastNewAt > STALE_MS) {
        reloads++; log('stale for', Math.round((Date.now() - lastNewAt) / 1000), 's — reloading');
        await load(); lastNewAt = Date.now();
      }
    } catch (e) {
      log('poll error:', e.message.split('\n')[0]);
      await page.waitForTimeout(5000);
      try { reloads++; await load(); lastNewAt = Date.now(); } catch (e2) { log('reload failed:', e2.message.split('\n')[0]); }
    }
  }
})().catch(e => { log('fatal:', e); writeStatus({ running: false, fatal: String(e) }); process.exit(1); });
