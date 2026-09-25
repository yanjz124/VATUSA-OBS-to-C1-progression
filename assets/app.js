import { fetchAll, toRow, summarize, toCSV } from './vatusa.js';

const CACHE_KEY = 'obs2c1:v1';
const CACHE_TTL_MS = 60 * 60 * 1000;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDays = d => Math.round(d).toLocaleString();
const yrs = d => (d / 365.25).toFixed(1);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = s => {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${MON[+m - 1]} ${+d}, ${y}`;
};
const fmtShort = s => {
  if (!s) return '';
  const [y, m] = s.split('-');
  return `${MON[+m - 1]} '${y.slice(2)}`;
};

let state = null; // { rows, summary, fetchedAt, failed, homeTotal }

/* ---------- cache ---------- */
function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (c && c.rows && Date.now() - c.fetchedAt < CACHE_TTL_MS) return c;
  } catch (e) { /* storage unavailable */ }
  return null;
}
function writeCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* quota or disabled */ }
}

/* ---------- status ---------- */
function setStatus(kind, html) {
  const cls = { loading: 'Label--attention', live: 'Label--success', cached: 'Label--accent', error: 'Label--danger' }[kind];
  const txt = { loading: 'Loading', live: 'Live', cached: 'Cached', error: 'Error' }[kind];
  $('status').innerHTML = `<span class="Label ${cls}">${txt}</span><span>${html}</span>`;
}
function setProgress(pct) {
  $('progressWrap').hidden = pct === null;
  if (pct !== null) $('progressBar').style.width = pct + '%';
}
function showError(html) {
  $('errors').innerHTML = html ? `<div class="flash flash-error mb-4">${html}</div>` : '';
}
function showWarn(html) {
  $('errors').innerHTML = html ? `<div class="flash flash-warn mb-4">${html}</div>` : '';
}

/* ---------- load ---------- */
async function load(force = false) {
  $('refreshBtn').disabled = true;
  $('dlBtn').disabled = true;
  showError('');

  const cached = force ? null : readCache();
  if (cached) {
    setProgress(null);
    return finish(cached, true);
  }

  setStatus('loading', 'Fetching facility list…');
  setProgress(2);
  try {
    const res = await fetchAll((done, total, fac) => {
      setProgress(Math.round(done / total * 100));
      setStatus('loading', `Fetched ${esc(fac)} &middot; ${done}/${total} facilities`);
    });
    const rows = res.members.map(toRow).filter(Boolean);
    if (!rows.length) throw new Error('The API returned no C1+ controllers.');
    const data = { rows, fetchedAt: Date.now(), failed: res.failed, homeTotal: res.homeTotal, facCount: res.facilities.length };
    if (!res.failed.length) writeCache(data);
    setProgress(null);
    finish(data, false);
  } catch (e) {
    setProgress(null);
    setStatus('error', 'Could not load data');
    showError(`Couldn't reach the VATUSA API (${esc(e.message)}). It may be down or rate-limiting;
      try <a href="#" id="retryLink">again</a> in a minute.`);
    $('retryLink').addEventListener('click', ev => { ev.preventDefault(); load(true); });
    $('refreshBtn').disabled = false;
  }
}

function finish(data, fromCache) {
  state = { ...data, summary: summarize(data.rows) };
  const when = new Date(data.fetchedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  setStatus(fromCache ? 'cached' : 'live',
    `${fromCache ? 'Cached from' : 'Fetched'} ${esc(when)} &middot; ${data.facCount} ARTCCs &middot; ` +
    `${(data.homeTotal || 0).toLocaleString()} home controllers`);
  if (data.failed && data.failed.length) {
    showWarn(`Some facilities failed to load and are missing: <strong>${data.failed.map(esc).join(', ')}</strong>.
      Hit “Refresh data” to try again.`);
  }
  $('refreshBtn').disabled = false;
  $('dlBtn').disabled = false;
  $('dlBtn').textContent = `Download CSV (${data.rows.length})`;
  render();
  $('app').hidden = false;
}

/* ---------- pieces ---------- */
function ladder(p) {
  if (!p.progression.length) return '';
  const nodes = [{ r: p.progression[0].from, date: null }].concat(p.progression.map(x => ({ r: x.to, date: x.date })));
  let c1i = p.counted ? nodes.findIndex((n, i) => i > 0 && n.r === 'C1') : -1;
  let html = '';
  nodes.forEach((n, i) => {
    const inWin = c1i >= 0 && i <= c1i;
    const edge = inWin && (i === 0 || i === c1i);
    if (i > 0) html += `<div class="conn${inWin ? ' win' : ''}"></div>`;
    const cls = edge ? 'Label--accent' : inWin ? 'Label--primary' : 'Label--secondary';
    html += `<div class="node"><span class="Label ${cls}">${esc(n.r)}</span>` +
      `<span class="dt">${n.date ? esc(fmtShort(n.date)) : '&nbsp;'}</span></div>`;
  });
  return `<div class="ladder">${html}</div>`;
}

function card(p, rank, tone) {
  const color = tone === 'fast' ? 'color-fg-success' : tone === 'slow' ? 'color-fg-danger' : 'color-fg-accent';
  const dur = p.counted
    ? `<span class="text-mono text-bold ${color}">${fmtDays(p.days)}d &middot; ${yrs(p.days)}y</span>`
    : `<span class="Label Label--secondary">omitted</span>`;
  const meta = p.counted
    ? `CID ${p.cid} &middot; ${esc(fmtDate(p.start))} &rarr; ${esc(fmtDate(p.c1))} &middot; now ${esc(p.rating)}`
    : `CID ${p.cid} &middot; now ${esc(p.rating)} &middot; ${esc(p.omitReason)}`;
  return `<div class="Box-row">
    <div class="d-flex flex-justify-between flex-items-baseline flex-wrap" style="gap:8px">
      <div>${rank ? `<span class="text-mono f6 color-fg-muted mr-1">${rank}.</span>` : ''}
        <strong>${esc(p.name)}</strong>
        <span class="Label ml-1" title="${esc(p.facName)}">${esc(p.facility)}</span></div>
      ${dur}
    </div>
    <div class="f6 color-fg-muted text-mono mt-1">${meta}</div>
    ${ladder(p)}
  </div>`;
}

/* ---------- render ---------- */
function render() {
  const { division: D, histogram, fastest, slowest, facilities } = state.summary;

  $('medBig').innerHTML = `${yrs(D.medianDays)}<span class="f3 color-fg-muted"> yr</span>`;
  $('meanSub').innerHTML = `${fmtDays(D.medianDays)} days &middot; mean ${yrs(D.meanDays)} yr`;

  // Histogram
  const maxH = Math.max(1, ...histogram.map(h => h.count));
  $('bars').innerHTML = histogram.map(h =>
    `<div class="bar tooltipped tooltipped-n" aria-label="${esc(h.label)}: ${h.count} controllers" style="height:${h.count / maxH * 100}%"><span>${h.count}</span></div>`
  ).join('');
  $('barsX').innerHTML = histogram.map(h => `<div>${esc(h.label)}</div>`).join('');
  $('distTot').textContent = `n = ${D.n}`;

  // Tiles
  $('nCounted').textContent = D.n;
  const tiles = [
    { k: 'Counted', v: D.n, foot: `of ${D.total} C1+` },
    { k: 'Median', v: fmtDays(D.medianDays), u: 'd', foot: `${yrs(D.medianDays)} yr` },
    { k: 'Mean', v: fmtDays(D.meanDays), u: 'd', foot: `${yrs(D.meanDays)} yr` },
    { k: 'Fastest', v: fmtDays(D.minDays), u: 'd', foot: esc(fastest[0]?.name || '') },
    { k: 'Slowest', v: fmtDays(D.maxDays), u: 'd', foot: `${yrs(D.maxDays)} yr &middot; ${esc(slowest[0]?.name || '')}` },
    { k: 'Omitted', v: D.omitted, foot: 'missing / transfer' },
  ];
  $('tiles').innerHTML = tiles.map(t => `<div class="Box p-3">
    <div class="f6 text-mono text-uppercase color-fg-muted">${t.k}</div>
    <div class="f2 text-mono text-bold lh-condensed mt-1">${t.v}${t.u ? `<span class="f5 color-fg-muted">${t.u}</span>` : ''}</div>
    <div class="f6 color-fg-muted text-truncate">${t.foot}</div></div>`).join('');

  // Leaders
  $('fastList').innerHTML = fastest.map((p, i) => card(p, i + 1, 'fast')).join('');
  $('slowList').innerHTML = slowest.map((p, i) => card(p, i + 1, 'slow')).join('');

  // Range plot
  const plotMax = Math.max(1, ...facilities.map(f => f.slow.days));
  const sq = v => Math.sqrt(Math.max(0, v)) / Math.sqrt(plotMax) * 100;
  $('plot').innerHTML = facilities.map(f => {
    const lo = sq(f.fast.days), hi = sq(f.slow.days), md = sq(f.medianDays);
    return `<div class="prow"><div class="pfac">${esc(f.fac)}</div><div class="track"><div class="axis"></div>
      <div class="rng" style="left:${lo}%;width:${hi - lo}%"></div>
      <div class="pt f" style="left:${lo}%" title="Fastest ${fmtDays(f.fast.days)}d: ${esc(f.fast.name)}"></div>
      <div class="pt s" style="left:${hi}%" title="Slowest ${fmtDays(f.slow.days)}d: ${esc(f.slow.name)}"></div>
      <div class="pt m" style="left:${md}%" title="Median ${fmtDays(f.medianDays)}d"></div></div></div>`;
  }).join('');
  const ticks = [0, 180, 365, 730, 1460, 2922, 5844].filter(t => t <= plotMax * 1.02);
  $('plotScale').innerHTML = ticks.map(t =>
    `<span style="left:${sq(t)}%">${t === 0 ? '0' : t >= 365 ? Math.round(t / 365.25) + 'y' : t + 'd'}</span>`).join('');

  // Facility table
  const maxMed = Math.max(1, ...facilities.map(f => f.medianDays));
  const many = (arr, tone) => arr.length ? arr.map((p, i) => card(p, i + 1, tone)).join('')
    : '<div class="Box-row f6 color-fg-muted">All controllers are shown under fastest.</div>';
  $('facBody').innerHTML = facilities.map(f => `<details class="fac border-top">
    <summary class="fac-grid px-3 py-2">
      <span class="caret">&#9656;</span>
      <span class="text-mono text-bold" title="${esc(f.facName)}">${esc(f.fac)}</span>
      <span class="text-mono text-right">${f.n}</span>
      <span class="text-mono text-right">${fmtDays(f.meanDays)}</span>
      <span class="text-mono text-right text-bold color-fg-accent">${fmtDays(f.medianDays)}</span>
      <span class="hide-sm d-flex flex-column" style="gap:4px">
        <span class="mbar"><i style="width:${f.medianDays / maxMed * 100}%"></i></span>
        <span class="text-mono f6 color-fg-muted">${fmtDays(f.fast.days)} &rarr; ${fmtDays(f.slow.days)} d</span>
      </span>
    </summary>
    <div class="d-md-flex color-bg-subtle p-3 border-top" style="gap:16px">
      <div class="col-md-6 mb-3 mb-md-0"><div class="Box"><div class="Box-header py-2"><span class="dot dot-fast"></span>Fastest ${f.fast5.length}</div>${many(f.fast5, 'fast')}</div></div>
      <div class="col-md-6"><div class="Box"><div class="Box-header py-2"><span class="dot dot-slow"></span>Slowest ${f.slow5.length}</div>${many(f.slow5, 'slow')}</div></div>
    </div>
  </details>`).join('');

  // Omitted
  const omitted = state.rows.filter(r => !r.counted).sort((a, b) => a.facility.localeCompare(b.facility) || a.name.localeCompare(b.name));
  $('omitCount').textContent = omitted.length;
  $('omitList').innerHTML = omitted.map(p => card(p, 0)).join('');

  renderSearch();
}

function renderSearch() {
  if (!state) return;
  const q = $('search').value.trim().toLowerCase();
  const out = $('searchResults');
  if (q.length < 2) { out.innerHTML = ''; return; }
  const counted = state.summary.counted;
  const hits = state.rows.filter(r => String(r.cid).includes(q) || r.name.toLowerCase().includes(q)).slice(0, 10);
  if (!hits.length) {
    out.innerHTML = `<div class="blankslate blankslate-narrow Box"><p class="mb-0">No C1+ home controller matches “${esc(q)}”.</p></div>`;
    return;
  }
  out.innerHTML = `<div class="Box">${hits.map(p => {
    let note = '';
    if (p.counted) {
      const rank = counted.findIndex(c => c.cid === p.cid) + 1;
      const pct = Math.round((1 - rank / counted.length) * 100);
      note = `<div class="Box-row py-2 color-bg-subtle f6">Rank <strong>${rank}</strong> of ${counted.length} &middot;
        faster than <strong>${pct}%</strong> of the division</div>`;
    }
    return card(p, 0) + note;
  }).join('')}</div>`;
}

/* ---------- controls ---------- */
$('refreshBtn').addEventListener('click', () => load(true));
$('dlBtn').addEventListener('click', () => {
  if (!state) return;
  const blob = new Blob([toCSV(state.rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vatusa_obs_to_c1_${new Date(state.fetchedAt).toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
let searchTimer;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 120); });

const MODES = ['auto', 'light', 'dark'];
const themeBtn = $('themeBtn');
const syncTheme = () => { themeBtn.textContent = 'Theme: ' + document.documentElement.getAttribute('data-color-mode'); };
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-color-mode');
  const next = MODES[(MODES.indexOf(cur) + 1) % MODES.length];
  document.documentElement.setAttribute('data-color-mode', next);
  try { localStorage.setItem('obs2c1:theme', next); } catch (e) { /* ignore */ }
  syncTheme();
});
syncTheme();

// On GitHub Pages (<user>.github.io/<repo>/), link back to the repo.
if (location.hostname.endsWith('.github.io')) {
  const user = location.hostname.split('.')[0];
  const repo = location.pathname.split('/').filter(Boolean)[0] || `${user}.github.io`;
  $('repoLink').href = `https://github.com/${user}/${repo}`;
  $('repoLink').hidden = false;
}

load();
