import {
  fetchAll, fetchUser, toRow, summarize, toCSV,
  STAGES, toStageRecord, stageDays, stageElapsed, summarizeStages, fasterThan,
} from './vatusa.js';

const CACHE_KEY = 'obs2c1:v2';
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

let state = null; // { rows, recs, summary, stages, fetchedAt, failed, homeTotal }

/* ---------- cache ---------- */
function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (c && c.rows && c.recs && Date.now() - c.fetchedAt < CACHE_TTL_MS) return c;
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
    const recs = res.members.map(toStageRecord);
    const data = { rows, recs, fetchedAt: Date.now(), failed: res.failed, homeTotal: res.homeTotal, facCount: res.facilities.length };
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
  state = { ...data, summary: summarize(data.rows), stages: summarizeStages(data.recs) };
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
  compareFromHash();
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
  renderStages();
}

function chainOf(r) {
  return [['S1', r.s1], ['S2', r.s2], ['S3', r.s3], ['C1', r.c1]].filter(x => x[1])
    .map(([k, d]) => `${k} ${esc(fmtDate(d.slice(0, 10)))}`).join(' &rarr; ');
}

// Row for a home controller who isn't C1+ (so isn't part of the OBS->C1 dataset).
function recCard(r) {
  const status = r.ratingId <= 1 ? 'Still OBS, no stages started yet'
    : r.ratingId < 5 ? `Currently ${esc(r.rating)}, hasn't reached C1 yet`
    : 'No promotion history on file';
  return `<div class="Box-row">
    <div><strong>${esc(r.name)}</strong> <span class="Label ml-1" title="${esc(r.facName)}">${esc(r.facility)}</span>
      <span class="Label Label--accent ml-1">${esc(r.rating)}</span></div>
    <div class="f6 color-fg-muted text-mono mt-1">CID ${r.cid} &middot; ${chainOf(r) || 'no promotions on record'}</div>
    <div class="f6 color-fg-muted mt-1">${status}.</div>
  </div>`;
}

function renderSearch() {
  if (!state) return;
  const q = $('search').value.trim().toLowerCase();
  const out = $('searchResults');
  if (q.length < 2) { out.innerHTML = ''; return; }
  const counted = state.summary.counted;
  const rowByCid = new Map(state.rows.map(r => [r.cid, r]));
  const all = state.recs.filter(r => String(r.cid).includes(q) || r.name.toLowerCase().includes(q));
  all.sort((a, b) => (rowByCid.has(b.cid) - rowByCid.has(a.cid)) || (b.ratingId - a.ratingId));
  const hits = all.slice(0, 10);
  if (!hits.length) {
    const isCid = /^[0-9]+$/.test(q);
    out.innerHTML = `<div class="blankslate blankslate-narrow Box"><p class="mb-0">No controller on any VATUSA home roster matches “${esc(q)}”.
      ${isCid ? 'Enter the full CID under <a href="#compare">Compare a controller</a>, which also checks VATUSA for members who aren\'t on a home roster.' : ''}</p></div>`;
    return;
  }
  out.innerHTML = `<div class="Box">${hits.map(r => {
    const p = rowByCid.get(r.cid);
    let html = p ? card(p, 0) : recCard(r);
    if (p && p.counted) {
      const rank = counted.findIndex(c => c.cid === p.cid) + 1;
      const pct = Math.round((1 - rank / counted.length) * 100);
      html += `<div class="Box-row py-2 color-bg-subtle f6">Rank <strong>${rank}</strong> of ${counted.length} &middot;
        faster than <strong>${pct}%</strong> of the division</div>`;
    }
    return html + `<div class="Box-row py-2 f6"><button type="button" class="btn-link" data-compare="${r.cid}">Compare stage by stage &darr;</button></div>`;
  }).join('')}${all.length > hits.length ? `<div class="Box-footer f6 color-fg-muted">Showing 10 of ${all.length} matches. Refine the search to narrow it down.</div>` : ''}</div>`;
}

/* ---------- stages ---------- */
let matrixSort = { key: 'total', dir: 1 };

function renderStages() {
  const stages = state.stages;
  const maxV = Math.max(1, ...stages.map(s => s.division.p75)) * 1.15;
  const sq = v => Math.min(100, Math.sqrt(Math.max(0, v)) / Math.sqrt(maxV) * 100);
  $('stageBody').innerHTML = stages.map(s => {
    const d = s.division;
    return `<div class="Box-row stage-grid py-2">
      <span class="text-mono text-bold">${esc(s.label)}</span>
      <span class="text-mono text-right">${d.n.toLocaleString()}</span>
      <span class="text-mono text-right text-bold color-fg-accent">${fmtDays(d.median)}d</span>
      <span class="text-mono text-right">${fmtDays(d.mean)}d</span>
      <span class="hide-sm"><span class="iqr d-block tooltipped tooltipped-n" aria-label="Middle 50%: ${fmtDays(d.p25)}–${fmtDays(d.p75)} days">
        <span class="axis"></span>
        <span class="band" style="left:${sq(d.p25)}%;width:${sq(d.p75) - sq(d.p25)}%"></span>
        <span class="tick div" style="left:${sq(d.median)}%"></span></span>
        <span class="text-mono f6 color-fg-muted">${fmtDays(d.p25)} – ${fmtDays(d.p75)} d</span></span>
    </div>`;
  }).join('');
  renderMatrix();
}

function renderMatrix() {
  const stages = state.stages;
  const facs = [...new Map(state.recs.map(r => [r.facility, r.facName])).entries()];
  const med = (fac, s) => (s.fac.get(fac) ? s.fac.get(fac).median : null);
  const { key, dir } = matrixSort;
  facs.sort((a, b) => {
    if (key === 'fac') return dir * a[0].localeCompare(b[0]);
    const s = stages.find(x => x.key === key);
    const va = med(a[0], s), vb = med(b[0], s);
    if (va === null) return 1;
    if (vb === null) return -1;
    return dir * (va - vb);
  });
  const cell = (fac, s) => {
    const st = s.fac.get(fac);
    if (!st) return '<td class="na">–</td>';
    const ratio = Math.log2(st.median / Math.max(1, s.division.median));
    const pct = Math.round(Math.min(1, Math.abs(ratio)) * 35);
    const color = ratio < 0 ? 'var(--fast)' : 'var(--slow)';
    const bg = pct ? `background:color-mix(in srgb, ${color} ${pct}%, transparent)` : '';
    return `<td style="${bg}${st.n < 3 ? ';opacity:.6' : ''}" title="n = ${st.n}${st.n < 3 ? ' (small sample)' : ''}">${fmtDays(st.median)}</td>`;
  };
  const th = (k, label) => `<th data-sort="${k}"${key === k ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''}>` +
    `${esc(label)}${key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  $('stageMatrix').innerHTML =
    `<thead><tr>${th('fac', 'ARTCC')}${stages.map(s => th(s.key, s.label)).join('')}</tr></thead><tbody>` +
    `<tr class="div-row"><td>Division</td>${stages.map(s => `<td title="n = ${s.division.n}">${fmtDays(s.division.median)}</td>`).join('')}</tr>` +
    facs.map(([fac, name]) => `<tr><td title="${esc(name)}">${esc(fac)}</td>${stages.map(s => cell(fac, s)).join('')}</tr>`).join('') +
    '</tbody>';
}

$('stageMatrix').addEventListener('click', e => {
  const k = e.target.closest('th')?.dataset.sort;
  if (!k) return;
  matrixSort = { key: k, dir: matrixSort.key === k ? -matrixSort.dir : 1 };
  renderMatrix();
});

/* ---------- compare ---------- */
let cmpSeq = 0;
function runCompare(q) {
  const seq = ++cmpSeq;
  q = String(q || '').trim();
  const out = $('cmpOut');
  if (!state || !q) { out.innerHTML = ''; return; }
  const lq = q.toLowerCase();
  const hits = /^\d+$/.test(q)
    ? state.recs.filter(r => String(r.cid) === q)
    : lq.length >= 2 ? state.recs.filter(r => r.name.toLowerCase().includes(lq)) : [];
  if (!hits.length && /^[0-9]+$/.test(q)) { lookupOffRoster(q, seq); return; }
  if (!hits.length) {
    out.innerHTML = `<div class="blankslate blankslate-narrow Box"><p class="mb-0">No controller on any VATUSA home roster matches “${esc(q)}”.
      Controllers who aren't on a home roster can only be looked up by CID.</p></div>`;
    return;
  }
  if (hits.length > 1) {
    out.innerHTML = `<div class="Box"><div class="Box-header f6">${hits.length} matches, pick one</div>${hits.slice(0, 15).map(r =>
      `<div class="Box-row py-2"><button type="button" class="btn-link" data-compare="${r.cid}">${esc(r.name)}</button>
       <span class="Label ml-1">${esc(r.facility)}</span> <span class="f6 color-fg-muted text-mono">CID ${r.cid} &middot; ${esc(r.rating)}</span></div>`).join('')}</div>`;
    return;
  }
  renderCompare(hits[0]);
  try { history.replaceState(null, '', `#cid=${hits[0].cid}`); } catch (e) { /* ignore */ }
}

// CID isn't on any home roster: ask the API about it directly and use whatever it returns.
async function lookupOffRoster(cid, seq) {
  const out = $('cmpOut');
  out.innerHTML = `<div class="Box p-3 f6 color-fg-muted">CID ${esc(cid)} isn't on a VATUSA home roster. Checking VATUSA…</div>`;
  let u;
  try {
    u = await fetchUser(cid);
  } catch (e) {
    if (seq !== cmpSeq) return;
    out.innerHTML = `<div class="flash flash-error">Couldn't look up CID ${esc(cid)} (${esc(e.message)}). Try again in a minute.</div>`;
    return;
  }
  if (seq !== cmpSeq) return;
  if (!u) {
    out.innerHTML = `<div class="blankslate blankslate-narrow Box"><p class="mb-0">VATUSA has no record of CID ${esc(cid)}, so there's no data to show.</p></div>`;
    return;
  }
  const rec = toStageRecord({ ...u, _fac: { id: u.facility || '—', name: '' } });
  const note = `Not on a VATUSA home roster (facility on file: <strong>${esc(u.facility || 'none')}</strong>), e.g. a visitor, a transfer or an inactive member.`;
  if (Array.isArray(u.promotions) && u.promotions.length) {
    renderCompare(rec, note);
  } else {
    renderCompare(rec, `${note} VATUSA doesn't publish promotion history for controllers outside the home rosters, so there's no stage data to compare.`, true);
  }
  try { history.replaceState(null, '', `#cid=${rec.cid}`); } catch (e) { /* ignore */ }
}

function renderCompare(r, note = '', noHistory = false) {
  const chain = chainOf(r);
  const rows = [];
  const skipped = [], notYet = [];
  const START_RATING = { s1: 2, s2: 3, s3: 4 };
  for (const s of state.stages) {
    const done = stageDays(r, s);
    const wip = done === null ? stageElapsed(r, s) : null;
    if (done === null && wip === null) {
      (!r[s.from] && r.ratingId < START_RATING[s.from] ? notYet : skipped).push(s.label);
      continue;
    }
    const v = done ?? wip;
    const div = s.division;
    const fac = s.fac.get(r.facility);
    let divNote, facNote = '';
    if (done !== null) {
      divNote = `faster than <strong>${Math.round(fasterThan(div.values, v) * 100)}%</strong>`;
      if (fac) facNote = `faster than <strong>${Math.round(fasterThan(fac.values, v) * 100)}%</strong>`;
    } else {
      const shorter = vals => Math.round(vals.filter(x => x < v).length / Math.max(1, vals.length) * 100);
      divNote = `${shorter(div.values)}% finished sooner`;
      if (fac) facNote = `${shorter(fac.values)}% finished sooner`;
    }
    const maxV = Math.max(div.p90, v, fac ? fac.median : 0) * 1.1 || 1;
    const sq = x => Math.min(100, Math.sqrt(Math.max(0, x)) / Math.sqrt(maxV) * 100);
    rows.push(`<div class="Box-row cmp-grid">
      <span class="text-mono text-bold">${esc(s.label)}</span>
      <span class="text-mono"><strong class="f4">${fmtDays(v)}d</strong>
        ${wip !== null ? '<span class="Label Label--attention ml-1">so far</span>' : ''}</span>
      <span class="f6"><span class="color-fg-muted">${esc(r.facility)} median</span><br>
        <span class="text-mono">${fac ? `${fmtDays(fac.median)}d <span class="color-fg-muted">(n ${fac.n})</span>` : '–'}</span>
        ${facNote ? `<br><span class="color-fg-muted">${facNote}</span>` : ''}</span>
      <span class="f6"><span class="color-fg-muted">Division median</span><br>
        <span class="text-mono">${fmtDays(div.median)}d <span class="color-fg-muted">(n ${div.n})</span></span>
        <br><span class="color-fg-muted">${divNote}</span></span>
      <span class="cmp-bar"><span class="iqr d-block">
        <span class="axis"></span>
        <span class="band" style="left:${sq(div.p25)}%;width:${sq(div.p75) - sq(div.p25)}%"></span>
        <span class="tick div" style="left:${sq(div.median)}%" title="Division median ${fmtDays(div.median)}d"></span>
        ${fac ? `<span class="tick fac" style="left:${sq(fac.median)}%" title="${esc(r.facility)} median ${fmtDays(fac.median)}d"></span>` : ''}
        <span class="you ${wip !== null ? 'wip' : 'done'}" style="left:${sq(v)}%" title="${fmtDays(v)}d"></span>
      </span></span>
    </div>`);
  }
  $('cmpOut').innerHTML = `<div class="Box">
    <div class="Box-header">
      <div class="d-flex flex-items-baseline flex-wrap" style="gap:6px">
        <strong class="f4">${esc(r.name)}</strong><span class="Label">${esc(r.facility)}</span>
        <span class="Label Label--accent">${esc(r.rating)}</span>
        <span class="f6 color-fg-muted text-mono">CID ${r.cid}</span></div>
      <div class="f6 color-fg-muted text-mono mt-1">${chain || 'No promotions on record'}</div>
    </div>
    ${note ? `<div class="Box-row py-2 f6 color-bg-subtle">${note}</div>` : ''}
    ${rows.join('') || (noHistory ? '' : `<div class="Box-row color-fg-muted">${r.ratingId <= 1
      ? 'Still OBS: no stages started yet, so there\'s nothing to compare.'
      : 'No usable promotion dates on record (often a transfer from another division or an incomplete legacy log), so there\'s nothing to compare.'}</div>`)}
    ${notYet.length && rows.length ? `<div class="Box-row py-2 f6 color-fg-muted">Not reached yet: ${notYet.map(esc).join(', ')}</div>` : ''}
    ${skipped.length && rows.length ? `<div class="Box-row py-2 f6 color-fg-muted">No record for: ${skipped.map(esc).join(', ')} (skipped rating or incomplete legacy log)</div>` : ''}
    <div class="Box-footer f6 color-fg-muted text-mono flex-wrap ${rows.length ? 'd-flex' : 'd-none'}" style="gap:14px">
      <span><i class="dot dot-you"></i>this controller</span><span><i class="dot dot-med"></i>division median</span>
      <span><i class="dot dot-fac"></i>facility median</span><span>band = division middle 50% &middot; &radic;-scaled</span>
    </div>
  </div>`;
}

function compareFromHash() {
  const m = location.hash.match(/cid=(\d+)/);
  if (m && state) { $('cmpInput').value = m[1]; runCompare(m[1]); }
}

$('cmpForm').addEventListener('submit', e => { e.preventDefault(); runCompare($('cmpInput').value); });
document.addEventListener('click', e => {
  const b = e.target.closest('[data-compare]');
  if (!b) return;
  $('cmpInput').value = b.dataset.compare;
  runCompare(b.dataset.compare);
  $('compare').scrollIntoView({ behavior: 'smooth' });
});
window.addEventListener('hashchange', compareFromHash);

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
