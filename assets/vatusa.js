// Data layer: pulls home rosters from the public VATUSA API and computes OBS->C1 stats.
// No DOM access here, so it can also run under Node for testing.

export const API = 'https://api.vatusa.net/v2';

export const RATINGS = {
  '-1': 'INA', 0: 'SUS', 1: 'OBS', 2: 'S1', 3: 'S2', 4: 'S3', 5: 'C1',
  6: 'C2', 7: 'C3', 8: 'I1', 9: 'I2', 10: 'I3', 11: 'SUP', 12: 'ADM',
};
const C1 = 5;
const DAY_MS = 86400000;

async function getJSON(url, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const unwrap = j => {
  const d = j && j.data !== undefined ? j.data : j;
  return Array.isArray(d) ? d : Object.values(d || {});
};

export async function fetchFacilities() {
  return unwrap(await getJSON(`${API}/facility`))
    .filter(f => f.active && /^[A-Z]{3}$/.test(f.id) && f.id !== 'ZHQ' && f.id !== 'ZAE')
    .map(f => ({ id: f.id, name: f.name }));
}

// Fetches every facility's home roster. onProgress(done, total, facId) fires as each completes.
export async function fetchAll(onProgress = () => {}) {
  const facs = await fetchFacilities();
  let done = 0;
  const failed = [];
  const rosters = await Promise.all(facs.map(async f => {
    try {
      const members = unwrap(await getJSON(`${API}/facility/${f.id}/roster/home`));
      return members.map(m => ({ ...m, _fac: f }));
    } catch (e) {
      failed.push(f.id);
      return [];
    } finally {
      onProgress(++done, facs.length, f.id);
    }
  }));
  const seen = new Map();
  let homeTotal = 0;
  for (const m of rosters.flat()) {
    if (seen.has(m.cid)) continue;
    seen.set(m.cid, m);
    homeTotal++;
  }
  return { members: [...seen.values()], homeTotal, facilities: facs, failed };
}

const day = iso => (iso ? String(iso).slice(0, 10) : '');

// Turns one roster member into a row. Returns null for anyone below C1.
export function toRow(m) {
  if (!(m.rating >= C1)) return null;
  const promos = (m.promotions || [])
    .filter(p => p.created_at)
    .slice()
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const find = (from, to, after) => promos.find(p => p.from === from && p.to === to &&
    (!after || new Date(p.created_at) >= new Date(after.created_at)));

  const obsS1 = find(1, 2);
  const s3c1 = find(4, 5, obsS1);
  const s1s2 = find(2, 3, obsS1);
  const s2s3 = find(3, 4, obsS1);

  let omit = [];
  if (!obsS1) omit.push('no OBS->S1');
  if (!s3c1) omit.push('no S3->C1');
  const days = omit.length ? null
    : Math.round((new Date(s3c1.created_at) - new Date(obsS1.created_at)) / DAY_MS * 10) / 10;

  const name = m.flag_nameprivacy ? `CID ${m.cid}` : `${m.fname || ''} ${m.lname || ''}`.trim();
  return {
    cid: m.cid,
    name,
    facility: m._fac ? m._fac.id : m.facility,
    facName: m._fac ? m._fac.name : '',
    rating: m.rating_short || RATINGS[m.rating] || String(m.rating),
    counted: days !== null,
    omitReason: omit.join(' & '),
    start: day(obsS1 && obsS1.created_at),
    s1s2: day(s1s2 && s1s2.created_at),
    s2s3: day(s2s3 && s2s3.created_at),
    c1: day(s3c1 && s3c1.created_at),
    days,
    progression: promos.map(p => ({
      from: RATINGS[p.from] || String(p.from),
      to: RATINGS[p.to] || String(p.to),
      date: day(p.created_at),
    })),
  };
}

const median = a => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export const HIST_BINS = [
  { label: '<0.5y', lo: 0, hi: 0.5 }, { label: '0.5–1y', lo: 0.5, hi: 1 },
  { label: '1–1.5y', lo: 1, hi: 1.5 }, { label: '1.5–2y', lo: 1.5, hi: 2 },
  { label: '2–3y', lo: 2, hi: 3 }, { label: '3–4y', lo: 3, hi: 4 },
  { label: '4–6y', lo: 4, hi: 6 }, { label: '6y+', lo: 6, hi: Infinity },
];

export function summarize(rows) {
  const counted = rows.filter(r => r.counted).sort((a, b) => a.days - b.days);
  const days = counted.map(r => r.days);
  const division = {
    n: counted.length,
    total: rows.length,
    omitted: rows.length - counted.length,
    meanDays: mean(days),
    medianDays: median(days),
    minDays: days.length ? days[0] : 0,
    maxDays: days.length ? days[days.length - 1] : 0,
  };
  const histogram = HIST_BINS.map(b => ({
    label: b.label,
    count: counted.filter(r => r.days / 365.25 >= b.lo && r.days / 365.25 < b.hi).length,
  }));

  const byFac = new Map();
  for (const r of counted) {
    if (!byFac.has(r.facility)) byFac.set(r.facility, []);
    byFac.get(r.facility).push(r);
  }
  const facilities = [...byFac.entries()].map(([fac, list]) => {
    const d = list.map(r => r.days);
    const fast5 = list.slice(0, 5);
    const slow5 = list.slice(Math.max(5, list.length - 5)).reverse();
    return {
      fac,
      facName: list[0].facName,
      n: list.length,
      meanDays: mean(d),
      medianDays: median(d),
      fast: list[0],
      slow: list[list.length - 1],
      fast5,
      slow5,
    };
  }).sort((a, b) => a.medianDays - b.medianDays);

  return {
    division,
    histogram,
    fastest: counted.slice(0, 10),
    slowest: counted.slice(-10).reverse(),
    facilities,
    counted,
  };
}

export const CSV_COLUMNS = [
  ['CID', r => r.cid], ['Name', r => r.name], ['Facility', r => r.facility],
  ['FacilityName', r => r.facName], ['CurrentRating', r => r.rating],
  ['Status', r => (r.counted ? 'counted' : 'omitted')], ['OmitReason', r => r.omitReason],
  ['Date_OBS_S1', r => r.start], ['Date_S1_S2', r => r.s1s2], ['Date_S2_S3', r => r.s2s3],
  ['Date_S3_C1', r => r.c1], ['Days_OBS_to_C1', r => (r.days ?? '')],
  ['Years_OBS_to_C1', r => (r.days == null ? '' : (r.days / 365.25).toFixed(2))],
  ['FullProgression', r => r.progression.map(p => `${p.from}>${p.to}:${p.date}`).join('; ')],
];

export function toCSV(rows) {
  const esc = v => {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const sorted = [...rows].sort((a, b) =>
    (a.counted === b.counted ? 0 : a.counted ? -1 : 1) || ((a.days ?? 0) - (b.days ?? 0)));
  return '﻿' + [CSV_COLUMNS.map(c => c[0]).join(',')]
    .concat(sorted.map(r => CSV_COLUMNS.map(c => esc(c[1](r))).join(',')))
    .join('\r\n');
}
