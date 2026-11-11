// Slide pattern analyzer — reads data/rounds.jsonl (chronological) and writes
// data/report.md: distribution vs theory, streaks, Markov transitions, gaps,
// Bayesian rate estimate, and CUSUM drift detection.
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const LOG = path.join(DATA, 'rounds.jsonl');
const REPORT = path.join(DATA, 'report.md');
const THEO = m => (m <= 1.01 ? 0.98 / 1.01 : 0.98 / m); // P(result >= m), house edge 2%

const BUCKETS = [
  { name: '1.00–1.01x', lo: 1.00, hi: 1.01 },
  { name: '1.01–1.20x', lo: 1.01, hi: 1.20 },
  { name: '1.20–2.00x', lo: 1.20, hi: 2.00 },
  { name: '2.00–5.00x', lo: 2.00, hi: 5.00 },
  { name: '5.00–10.0x', lo: 5.00, hi: 10.0 },
  { name: '10.0–50.0x', lo: 10.0, hi: 50.0 },
  { name: '50.0–100 x', lo: 50.0, hi: 100 },
  { name: '100x+',      lo: 100,  hi: Infinity },
];
const bucketOf = v => BUCKETS.findIndex(b => v >= b.lo && v < b.hi);

const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '—');

function main() {
  if (!fs.existsSync(LOG)) { console.log('no data yet'); return; }
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length < 10) { console.log('need >=10 rounds, have', lines.length); return; }
  const rows = lines.map(l => JSON.parse(l));
  const xs = rows.map(r => r.multiplier);
  const n = xs.length;

  // ---- distribution vs theory + chi-square ----
  const obs = new Array(BUCKETS.length).fill(0);
  xs.forEach(v => { const b = bucketOf(v); obs[b >= 0 ? b : 0]++; });
  const theo = BUCKETS.map(b => (THEO(b.lo) - (b.hi === Infinity ? 0 : THEO(b.hi))) * n);
  let chi2 = 0;
  obs.forEach((o, i) => { if (theo[i] > 0) { chi2 += (o - theo[i]) ** 2 / theo[i]; } });
  const df = BUCKETS.length - 1;
  const pApprox = 1 - chiSquareCdf(chi2, df); // upper-tail p-value (approx)
  const chiTable95 = [3.84, 5.99, 7.81, 9.49, 11.07, 12.59, 14.07, 15.51, 16.92, 18.31];
  const significant = chi2 > (chiTable95[df - 1] ?? 18.31);

  // ---- streaks (>=2x vs <2x) ----
  const hi = xs.map(v => v >= 2 ? 1 : 0);
  let curStreak = 1, streakSign = hi[n - 1];
  for (let i = n - 2; i >= 0 && hi[i] === streakSign; i--) curStreak++;
  let maxLow = 0, maxHigh = 0, run = 1;
  for (let i = 1; i < n; i++) { if (hi[i] === hi[i - 1]) run++; else { hi[i] ? maxLow = Math.max(maxLow, run) : maxHigh = Math.max(maxHigh, run); run = 1; } }
  streakSign ? maxHigh = Math.max(maxHigh, run) : maxLow = Math.max(maxLow, run);

  // ---- Markov transitions over buckets ----
  const K = BUCKETS.length;
  const M = Array.from({ length: K }, () => new Array(K).fill(0));
  for (let i = 1; i < n; i++) { const a = bucketOf(xs[i - 1]), b = bucketOf(xs[i]); if (a >= 0 && b >= 0) M[a][b]++; }
  const rowTotals = M.map(r => r.reduce((a, b) => a + b, 0));

  // ---- gaps between big hits ----
  const gapStats = (thr) => {
    const gaps = []; let last = -1;
    xs.forEach((v, i) => { if (v >= thr) { if (last >= 0) gaps.push(i - last); last = i; } });
    const drought = last >= 0 ? n - 1 - last : n;
    return {
      hits: last >= 0 ? gaps.length + 1 : 0,
      avgGap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
      maxGap: gaps.length ? Math.max(...gaps) : null,
      droughtSinceLast: drought,
      roundsSinceStart: last >= 0 ? last : null,
    };
  };
  const g10 = gapStats(10), g50 = gapStats(50);

  // ---- rolling means / Bayesian rate ----
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const recent = k => mean(xs.slice(-k));
  const wins2 = xs.slice(-100).filter(v => v >= 2).length;
  const total100 = Math.min(100, n);
  const p2 = (wins2 + 1) / (total100 + 2); // Beta(1,1) posterior mean vs theory 0.49
  const ci = betaCI(wins2 + 1, total100 - wins2 + 1);

  // ---- CUSUM drift on P(>=2x) ----
  const target = THEO(2), cusum = [0];
  for (let i = 0; i < n; i++) {
    const z = (hi[i] - target) / Math.sqrt(target * (1 - target));
    cusum.push(Math.max(0, cusum[i] + z - 0.25)); // drift-down detector, k=0.25
  }
  const cusumMax = Math.max(...cusum);
  const drift = cusumMax > 4; // rough alarm threshold
  const driftStartIdx = drift ? cusum.findIndex((v, i) => v === cusumMax && v > 0) : -1;

  const first = rows[0].ts, lastTs = rows[n - 1].ts;

  const md = `# Slide Watcher Report
_Generated ${new Date().toISOString()}_

**Rounds observed:** ${n}  |  **Window:** ${first} → ${lastTs}

## Live distribution vs theory (P(X≥m) = 0.98/m)

| Bucket | Observed | Obs % | Theory % |
|---|---|---|---|
${BUCKETS.map((b, i) => `| ${b.name} | ${obs[i]} | ${fmt(100 * obs[i] / n, 2)} | ${fmt(100 * theo[i] / n, 2)} |`).join('\n')}

**Chi-square:** ${fmt(chi2, 2)} (df=${df}) → ${significant ? '⚠️ DEVIATION from theory (p<0.05)' : 'consistent with theory (no significant deviation)'}

## Streaks (threshold 2×)
- Current streak: **${curStreak} ${streakSign ? 'HIGH (≥2×)' : 'LOW (<2×)'}** rounds
- Longest LOW streak: ${maxLow} | Longest HIGH streak: ${maxHigh}

## Markov transitions (bucket → next bucket, row %)
| from \ to | ${BUCKETS.map(b => b.name).join(' | ')} |
|---|${' --- |'.repeat(K)}
${M.map((row, i) => `| ${BUCKETS[i].name} | ${row.map((c, j) => rowTotals[i] ? `${c} (${fmt(100 * c / rowTotals[i], 0)}%)` : '—').join(' | ')} |`).join('\n')}

_Row totals: ${rowTotals.join(', ')} — rows with few samples are noise._

## Gap analysis
| Threshold | Hits | Avg gap (rounds) | Max gap | Current drought |
|---|---|---|---|---|
| ≥10× | ${g10.hits} | ${fmt(g10.avgGap, 1)} | ${g10.maxGap ?? '—'} | ${g10.droughtSinceLast} |
| ≥50× | ${g50.hits} | ${fmt(g50.avgGap, 1)} | ${g50.maxGap ?? '—'} | ${g50.droughtSinceLast} |

## Hot/cold (rolling)
- Mean multiplier — last 10: **${fmt(recent(10), 2)}×** | last 50: ${fmt(recent(Math.min(50, n)), 2)}× | last 100: ${fmt(recent(total100), 2)}× | all-time: ${fmt(mean(xs), 2)}×
- P(≥2×) posterior (last ${total100} rounds): **${fmt(100 * p2, 1)}%** (CI95 ${fmt(100 * ci[0], 1)}–${fmt(100 * ci[1], 1)}%) vs theory 49.0%

## Drift detector (CUSUM on P(≥2×))
${drift ? `⚠️ Downward drift flagged — CUSUM=${fmt(cusumMax, 2)} (starts ~round ${driftStartIdx})` : `No drift — CUSUM=${fmt(cusumMax, 2)} (threshold 4)`}

---
_Rounds are provably fair and independent; streaks/hot-cold describe behavior, they do not predict. EV is −2% per bet before rakeback._
`;
  fs.writeFileSync(REPORT, md);
  fs.writeFileSync(path.join(DATA, 'analysis.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), rounds: n, chi2, significant,
    currentStreak: { length: curStreak, high: !!streakSign }, maxLow, maxHigh,
    p2Posterior: p2, drift, gaps: { ge10: g10, ge50: g50 },
  }, null, 2));
  console.log('report written:', REPORT);
}

// Wilson-ish beta interval via normal approx of posterior (good enough)
function betaCI(a, b) {
  const p = a / (a + b), z = 1.96;
  const s = Math.sqrt(p * (1 - p) / (a + b + 1));
  return [Math.max(0, p - z * s), Math.min(1, p + z * s)];
}
function chiSquareCdf(x, k) { // Wilson–Hilferty approximation
  if (x <= 0) return 1;
  const z = Math.pow(x / k, 1 / 3) - (1 - 2 / (9 * k)) / Math.sqrt(2 / (9 * k));
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(t) { const s = Math.sign(t); t = Math.abs(t); const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911; const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-t * t) / p; return s * y; }

main();
