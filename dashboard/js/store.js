// Basit gözlemlenebilir durum + localStorage kalıcılığı.

const BASE_KEY = 'dotnet-vs.v1';
let STORAGE_KEY = BASE_KEY;

/** Varsayılan dışı API adresleri (ör. A/A kontrolü) kendi kayıt alanını kullanır; gerçek sonuçlara karışmaz. */
export function setStorageNamespace(bases, defaults) {
  const custom = Object.keys(defaults).some((k) => bases[k] !== defaults[k]);
  STORAGE_KEY = custom ? `${BASE_KEY}:${Object.keys(bases).map((k) => bases[k]).join('|')}` : BASE_KEY;
}

function emptyLive() {
  return {
    phase: 'idle', // idle | queued | connecting | warmup | measure | done | error | aborted
    progress: 0,
    samples: [], // canlı ilerleme örnekleri
    last: null, // son ilerleme olayı
    result: null,
    error: null,
    measureStartedAt: 0, // istemci saati (ms), ölçüm fazı başlangıcı
    peakWs: 0,
    peakHeap: 0,
  };
}

const state = {
  bases: { net10: '', net11: '' },
  conn: {
    net10: { status: 'checking', info: null, error: null },
    net11: { status: 'checking', info: null, error: null },
  },
  workloads: [],
  workloadsError: null,
  selected: null,
  settings: { mode: 'fair', repeat: 3, scale: 1, warmup: true }, // mode: 'fair' (Adil ölçüm) | 'show' (Gösteri, aynı anda)
  run: { active: false, kind: null, workloadId: null, index: 0, total: 0, round: 0, rounds: 0, totalRuns: 0, doneRuns: 0, startedAt: 0, stopping: false },
  live: { net10: emptyLive(), net11: emptyLive() },
  results: {}, // { [workloadId]: { net10, net11, at, scale, warmup, mode } }
  lastSuite: null, // { ids:[], at, complete }
  infoSnapshot: { net10: null, net11: null }, // en son bilinen /api/info (çevrimdışıyken özet kartı için)
  presenting: false,
  view: 'main', // main | card
};

const listeners = new Set();
let scheduled = false;

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Durumu değiştirir ve bir sonraki karede (rAF) dinleyicileri bilgilendirir. */
export function update(mutator, { persist = false } = {}) {
  mutator(state);
  if (persist) save();
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      for (const fn of listeners) {
        try { fn(state); } catch (err) { console.error(err); }
      }
    });
  }
}

export function resetLive(rt) {
  state.live[rt] = emptyLive();
}

export function newLive() {
  return emptyLive();
}

/* ------------------------------------------------------------------ */

function save() {
  try {
    const payload = {
      v: 1,
      settings: state.settings,
      selected: state.selected,
      results: state.results,
      lastSuite: state.lastSuite,
      infoSnapshot: state.infoSnapshot,
      workloads: state.workloads,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* kota dolu / gizli mod: sessizce yok say */
  }
}

export function persistNow() {
  save();
}

export function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (!data || data.v !== 1) return;
    const s = data.settings || {};
    // Eski sürümden geçiş: parallel -> show, sequential -> fair
    if (s.mode === 'fair' || s.mode === 'show') state.settings.mode = s.mode;
    else if (s.mode === 'parallel') state.settings.mode = 'show';
    else if (s.mode === 'sequential') state.settings.mode = 'fair';
    if ([1, 3, 5].includes(s.repeat)) state.settings.repeat = s.repeat;
    if ([1, 2, 4].includes(s.scale)) state.settings.scale = s.scale;
    if (typeof s.warmup === 'boolean') state.settings.warmup = s.warmup;
    if (typeof data.selected === 'string') state.selected = data.selected;
    if (data.results && typeof data.results === 'object') {
      for (const [id, r] of Object.entries(data.results)) {
        if (!r || typeof r !== 'object' || !r.net10 || !r.net11) continue;
        if (r.mode === 'parallel') r.mode = 'show';
        else if (r.mode !== 'show' && r.mode !== 'fair') r.mode = 'fair';
        state.results[id] = r;
      }
    }
    if (data.lastSuite && Array.isArray(data.lastSuite.ids)) state.lastSuite = data.lastSuite;
    if (Array.isArray(data.workloads)) {
      state.workloads = data.workloads.filter((w) => w && typeof w.id === 'string');
      state.workloadsStale = true;
    }
    if (data.infoSnapshot && typeof data.infoSnapshot === 'object') {
      state.infoSnapshot.net10 = data.infoSnapshot.net10 ?? null;
      state.infoSnapshot.net11 = data.infoSnapshot.net11 ?? null;
    }
  } catch {
    /* bozuk kayıt: yok say */
  }
}

export function clearSaved() {
  state.results = {};
  state.lastSuite = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* yok say */ }
  save();
}
