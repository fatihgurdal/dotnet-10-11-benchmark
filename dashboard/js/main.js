// Uygulama giriş noktası: bağlantılar, iş yükleri, çalıştırma orkestrasyonu, görünüm güncellemeleri.
//
// Çalıştırma modları:
//  - "Adil ölçüm" (fair, varsayılan): runtime'lar SIRAYLA çalışır; N tur (1/3/5), her turda sıra dönüşümlü
//    (10→11, 11→10, …), her koşudan önce iki tarafta GC + ~1,5 sn soğuma. Sonuç = turların MEDYANI, min–max aralığıyla.
//  - "Gösteri (aynı anda)" (show): iki runtime eşzamanlı; kaynaklar paylaşıldığı için kesin ölçüm değildir.

import { RUNTIMES, DEFAULT_BASES, resolveBases, getInfo, getWorkloads, runStream, collectGc, ApiError } from './api.js';
import { getState, update, subscribe, load, newLive, clearSaved, setStorageNamespace } from './store.js';
import { createRuntimeCard, DIMM_CELL_COUNT } from './card.js';
import { createLineChart } from './charts.js';
import { computeSummary, metricChip, pairMetrics, aggregateRuns, sampleCount } from './summary.js';
import { renderVerdict, renderSuite, renderSlide, infoLine, limitsMatch, SHOW_BADGE_TEXT, SINGLE_TEXT, GC_LIMIT_LABEL, GC_LIMIT_HINT } from './suite.js';
import { h, setText, toggle } from './dom.js';
import * as fmt from './format.js';

const S = getState();
const $ = (id) => document.getElementById(id);
const RT_NAME = { net10: '.NET 10', net11: '.NET 11' };
const MAX_LIVE_SAMPLES = 3000;
const RETRY_MS = 15000;
const COOLDOWN_MS = 1500;
const SUITE_GAP_MS = 600;

/* ------------------------------------------------------------------ */
/* Başlangıç                                                            */
/* ------------------------------------------------------------------ */

S.bases = resolveBases();
setStorageNamespace(S.bases, DEFAULT_BASES);
load();

const cards = {
  net10: createRuntimeCard('net10', { major: 10 }),
  net11: createRuntimeCard('net11', { major: 11 }),
};
$('slot-net10').appendChild(cards.net10.root);
$('slot-net11').appendChild(cards.net11.root);

const COLORS = { net10: '#7dd3fc', net11: '#f472b6' };
const cpuChart = createLineChart($('chart-cpu'), {
  yMax: 100,
  yKind: 'percent',
  yFormat: (v) => fmt.pct(v),
  xFormat: (x) => `${fmt.num(x, 2)} sn`,
  ariaLabel: 'CPU kullanımı zaman grafiği',
  emptyText: 'Bir test başlatıldığında CPU kullanımı burada akar',
});
const memChart = createLineChart($('chart-mem'), {
  yMax: null,
  yKind: 'bytes',
  yFormat: (v) => fmt.bytes(v).replace(/,\d+/, ''),
  xFormat: (x) => `${fmt.num(x, 2)} sn`,
  ariaLabel: 'Bellek kullanımı zaman grafiği',
  emptyText: 'Çalışma kümesi ve GC heap burada izlenir',
});

let runCtrl = null;
const retryTimers = {};
let lastSuiteKey = '';
let lastPickerKey = '';
let lastMethodKey = '';
let lastSlideKey = '';
let resultsVersion = 0;

bindControls();
bindKeyboard();
subscribe(render);
update(() => {});
checkAll();

/* ------------------------------------------------------------------ */
/* Bağlantı ve iş yükleri                                               */
/* ------------------------------------------------------------------ */

async function checkConnection(rt) {
  clearTimeout(retryTimers[rt]);
  update((s) => { s.conn[rt].status = 'checking'; });
  try {
    const info = await getInfo(S.bases[rt]);
    update((s) => {
      s.conn[rt] = { status: info.busy === true ? 'busy' : 'up', info, error: null };
      s.infoSnapshot[rt] = info;
    }, { persist: true });
    return true;
  } catch (err) {
    update((s) => { s.conn[rt] = { status: 'down', info: null, error: err.message }; });
    retryTimers[rt] = setTimeout(() => { if (!S.run.active) checkConnection(rt).then((ok) => ok && loadWorkloads()); }, RETRY_MS);
    return false;
  }
}

async function checkAll() {
  const res = await Promise.all(RUNTIMES.map(checkConnection));
  if (res.some(Boolean)) await loadWorkloads();
  else if (!S.workloads.length) update((s) => { s.workloadsError = 'API\'ye bağlanılamadı'; });
}

async function loadWorkloads() {
  const lists = await Promise.all(RUNTIMES.map((rt) =>
    S.conn[rt].status === 'down' ? Promise.resolve(null) : getWorkloads(S.bases[rt]).catch(() => null)));
  const [a, b] = lists;
  if (!a && !b) {
    update((s) => { if (!s.workloads.length) s.workloadsError = 'İş yükleri yüklenemedi'; });
    return;
  }
  // Birleşim: .NET 10 listesinin sırası esas, eksikler sona eklenir; her iş yükünün hangi runtime'da olduğu işaretlenir.
  const base = a || b;
  // on10/on11: true/false yalnızca o runtime'ın listesi okunabildiyse; okunamadıysa null (bilinmiyor)
  const mark = (w) => ({ ...w, on10: a ? a.some((x) => x.id === w.id) : null, on11: b ? b.some((x) => x.id === w.id) : null });
  const merged = base.map(mark);
  for (const w of (a ? b : a) || []) if (!merged.some((m) => m.id === w.id)) merged.push(mark(w));
  update((s) => {
    s.workloads = merged;
    s.workloadsStale = false;
    s.workloadsError = null;
    if (!s.selected || !merged.some((w) => w.id === s.selected)) s.selected = merged[0]?.id ?? null;
  }, { persist: true });
}

/* ------------------------------------------------------------------ */
/* Veri temizleme                                                       */
/* ------------------------------------------------------------------ */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function cleanProgress(d) {
  return {
    t: num(d.t),
    progress: Math.max(0, Math.min(1, num(d.progress) ?? 0)),
    cpuPercent: num(d.cpuPercent),
    workingSetBytes: num(d.workingSetBytes),
    gcHeapBytes: num(d.gcHeapBytes),
    totalAllocatedBytes: num(d.totalAllocatedBytes),
    gc0: num(d.gc0),
    gc1: num(d.gc1),
    gc2: num(d.gc2),
    opsDone: num(d.opsDone),
  };
}

function cleanResult(r) {
  const out = {};
  for (const k of ['durationMs', 'cpuTimeMs', 'avgCpuPercent', 'allocatedBytes', 'gc0', 'gc1', 'gc2', 'gcPauseMs',
    'peakWorkingSetBytes', 'peakGcHeapBytes', 'ops', 'opsPerSec', 'scale']) out[k] = num(r[k]);
  out.workloadId = typeof r.workloadId === 'string' ? r.workloadId : undefined;
  out.runtimeLabel = typeof r.runtimeLabel === 'string' ? r.runtimeLabel : undefined;
  out.warmup = typeof r.warmup === 'boolean' ? r.warmup : r.warmup === 1 ? true : r.warmup === 0 ? false : undefined;
  out.checksum = typeof r.checksum === 'string' || typeof r.checksum === 'number' ? r.checksum : undefined;
  out.samples = Array.isArray(r.samples) ? r.samples.filter((x) => x && typeof x === 'object').slice(0, 500).map(cleanProgress) : [];
  return out;
}

/** Ham tur sonucu (kalıcılık/dışa aktarım için örnekler hariç) */
function rawRun(r) {
  if (!r) return null;
  const { samples, ...rest } = r;
  return rest;
}

function errorText(rt, err) {
  const name = RT_NAME[rt];
  switch (err?.kind) {
    case 'busy': return `${name} şu anda başka bir testi çalıştırıyor. Bitmesini bekleyip tekrar deneyin.`;
    case 'notfound': return `${name} bu iş yükünü tanımıyor.`;
    case 'timeout': return `${name}: ${err.message}.`;
    case 'network': return `${name} sunucusuna ulaşılamadı.`;
    case 'server': return `${name} hata bildirdi: ${err.message}`;
    case 'protocol': return `${name}: ${err.message}.`;
    default: return `${name}: ${err?.message || 'bilinmeyen hata'}`;
  }
}

/* ------------------------------------------------------------------ */
/* Tek koşu                                                             */
/* ------------------------------------------------------------------ */

async function runOne(rt, workloadId, settings, signal) {
  update((s) => { s.live[rt].phase = 'connecting'; s.run.currentRt = rt; });
  try {
    const raw = await runStream(S.bases[rt], workloadId, settings, {
      onStart: (d) => update((s) => {
        s.live[rt].startInfo = { runId: d.runId, runtimeLabel: typeof d.runtimeLabel === 'string' ? d.runtimeLabel : undefined };
        if (s.live[rt].phase === 'connecting') s.live[rt].phase = settings.warmup ? 'warmup' : 'measure';
        if (s.live[rt].phase === 'measure') s.live[rt].measureStartedAt = performance.now();
      }),
      onPhase: (d) => update((s) => {
        const L = s.live[rt];
        if (d.phase === 'warmup') { L.phase = 'warmup'; L.progress = 0; }
        else if (d.phase === 'measure') {
          L.phase = 'measure';
          L.measureStartedAt = performance.now();
          L.samples = [];
          L.peakWs = 0;
          L.peakHeap = 0;
          L.progress = 0;
        }
      }),
      onProgress: (d) => update((s) => {
        const L = s.live[rt];
        if (L.phase === 'warmup') return; // sözleşmeye göre ısınmada ilerleme yok; gelirse yok say
        if (L.phase !== 'measure') { L.phase = 'measure'; L.measureStartedAt = performance.now(); }
        const p = cleanProgress(d);
        L.last = p;
        L.progress = Math.max(L.progress, p.progress);
        if (L.samples.length < MAX_LIVE_SAMPLES) L.samples.push(p);
        if (p.workingSetBytes > L.peakWs) L.peakWs = p.workingSetBytes;
        if (p.gcHeapBytes > L.peakHeap) L.peakHeap = p.gcHeapBytes;
      }),
    }, signal);
    const result = cleanResult(raw);
    update((s) => {
      const L = s.live[rt];
      L.result = result;
      L.phase = 'done';
      L.progress = 1;
      L.finishedAt = Date.now();
      s.run.doneRuns++;
      s.run.lastDoneAt = performance.now();
    });
    return result;
  } catch (err) {
    const aborted = err?.kind === 'aborted' || signal?.aborted;
    update((s) => {
      s.live[rt].phase = aborted ? 'aborted' : 'error';
      s.live[rt].error = aborted ? null : errorText(rt, err);
      s.live[rt].errorKind = err?.kind;
      if (!aborted) { s.run.doneRuns++; s.run.lastDoneAt = performance.now(); }
    });
    if (!aborted) {
      toast(errorText(rt, err), err?.kind === 'busy' ? 'warn' : 'error');
      if (err?.kind === 'network' || err?.kind === 'timeout') checkConnection(rt);
    }
    throw err;
  }
}

function resetLiveFor(rt, workloadId, phase, round) {
  update((s) => {
    s.live[rt] = newLive();
    s.live[rt].workloadId = workloadId;
    s.live[rt].phase = phase;
    s.live[rt].round = round;
  });
}

/* ------------------------------------------------------------------ */
/* Bir iş yükü: gösteri (aynı anda) veya adil ölçüm (sırayla, N tur)    */
/* ------------------------------------------------------------------ */

async function runShow(workloadId, settings, signal) {
  for (const rt of RUNTIMES) resetLiveFor(rt, workloadId, 'connecting', 1);
  update((s) => { s.run.round = 1; s.run.rounds = 1; });
  const out = await Promise.allSettled(RUNTIMES.map((rt) => runOne(rt, workloadId, settings, signal)));
  const r10 = out[0].status === 'fulfilled' ? out[0].value : null;
  const r11 = out[1].status === 'fulfilled' ? out[1].value : null;
  if (!r10 || !r11) return false;
  const a10 = aggregateRuns([r10]);
  const a11 = aggregateRuns([r11]);
  storePair(workloadId, settings, a10, a11, [{ order: ['net10', 'net11'], parallel: true, net10: rawRun(r10), net11: rawRun(r11) }]);
  return true;
}

async function cooldown(signal) {
  update((s) => { s.run.cooling = true; });
  await Promise.allSettled(RUNTIMES.map((rt) => collectGc(S.bases[rt])));
  await sleep(COOLDOWN_MS, signal);
  update((s) => { s.run.cooling = false; });
}

async function runFair(workloadId, settings, signal) {
  const N = settings.repeat;
  const rounds = [];
  for (const rt of RUNTIMES) resetLiveFor(rt, workloadId, 'queued', 1);
  update((s) => { s.run.rounds = N; });

  for (let j = 0; j < N && !signal.aborted; j++) {
    // Dönüşümlü sıra (ABBA): 10→11, 11→10, 10→11, …
    const order = j % 2 === 0 ? ['net10', 'net11'] : ['net11', 'net10'];
    const round = { order };
    update((s) => { s.run.round = j + 1; });
    for (const rt of order) {
      if (signal.aborted) break;
      if (S.live[rt].phase !== 'done' || S.live[rt].round !== j + 1) resetLiveFor(rt, workloadId, 'queued', j + 1);
      await cooldown(signal);
      if (signal.aborted) break;
      resetLiveFor(rt, workloadId, 'connecting', j + 1);
      try {
        round[rt] = await runOne(rt, workloadId, settings, signal);
      } catch {
        break; // bu turu bırak; sonraki tura geç (iptal edildiyse döngü zaten biter)
      }
      // Diğer runtime bu turda henüz koşmadıysa "sırada" göster
      const other = rt === 'net10' ? 'net11' : 'net10';
      if (!round[other] && !signal.aborted) update((s) => { if (s.live[other].phase === 'done') s.live[other].phase = 'queued'; s.live[other].round = j + 1; });
    }
    if (round.net10 && round.net11) rounds.push(round);
  }
  if (signal.aborted || !rounds.length) return false;

  const a10 = aggregateRuns(rounds.map((r) => r.net10));
  const a11 = aggregateRuns(rounds.map((r) => r.net11));
  storePair(workloadId, settings, a10, a11, rounds.map((r) => ({ order: r.order, net10: rawRun(r.net10), net11: rawRun(r.net11) })));
  if (rounds.length < N) toast(`${rounds.length}/${N} tur tamamlanabildi; medyan bu turlardan hesaplandı.`, 'warn');
  return true;
}

function storePair(workloadId, settings, a10, a11, rounds) {
  update((s) => {
    s.results[workloadId] = {
      net10: a10,
      net11: a11,
      at: Date.now(),
      scale: settings.scale,
      warmup: settings.warmup,
      mode: settings.mode,
      repeat: settings.mode === 'show' ? 1 : settings.repeat,
      n: Math.min(a10.n, a11.n),
      rounds,
    };
    // Kartlar artık toplanmış (medyan) sonucu göstersin
    for (const rt of RUNTIMES) {
      s.live[rt].result = rt === 'net10' ? a10 : a11;
      s.live[rt].phase = 'done';
      s.live[rt].aggregated = true;
      s.live[rt].progress = 1;
      s.live[rt].samples = (rt === 'net10' ? a10 : a11).samples?.length ? [] : s.live[rt].samples;
    }
    resultsVersion++;
  }, { persist: true });
}

function runWorkload(id, settings, signal) {
  return settings.mode === 'show' ? runShow(id, settings, signal) : runFair(id, settings, signal);
}

function currentSettings() {
  return { ...S.settings };
}

function runsPerWorkload(settings) {
  return settings.mode === 'show' ? 2 : 2 * settings.repeat;
}

async function startSingle() {
  if (S.run.active || !S.selected) return;
  const id = S.selected;
  const ctrl = new AbortController();
  runCtrl = ctrl;
  const settings = currentSettings();
  update((s) => {
    s.run = { active: true, kind: 'single', workloadId: id, index: 1, total: 1, round: 1, rounds: settings.mode === 'show' ? 1 : settings.repeat,
      totalRuns: runsPerWorkload(settings), doneRuns: 0, startedAt: performance.now(), stopping: false, mode: settings.mode };
  });
  try {
    const ok = await runWorkload(id, settings, ctrl.signal);
    if (ok) toast('Test tamamlandı.', 'ok', 2200);
    else if (ctrl.signal.aborted) toast('Durduruldu.', 'warn', 2200);
  } finally {
    if (runCtrl === ctrl) runCtrl = null;
    update((s) => {
      s.run = idleRun();
      // İptalde yarım kalan tur sonuçlarını gösterme; kayıtlı (medyan) sonuç görünsün
      if (ctrl.signal.aborted) for (const rt of RUNTIMES) if (!s.live[rt].aggregated) s.live[rt] = newLive();
      // Koşu bittiyse (ör. diğer taraf 409 verdi) "sırada / bağlanıyor" durumunda kalan kart olmasın
      for (const rt of RUNTIMES) if (['queued', 'connecting', 'warmup', 'measure'].includes(s.live[rt].phase)) s.live[rt] = newLive();
    });
  }
}

function idleRun() {
  return { active: false, kind: null, workloadId: null, index: 0, total: 0, round: 0, rounds: 0, totalRuns: 0, doneRuns: 0, startedAt: 0, stopping: false };
}

async function startSuite() {
  if (S.run.active) return;
  const ids = S.workloads.filter((w) => w.on10 !== false && w.on11 !== false).map((w) => w.id);
  if (!ids.length) { toast('Çalıştırılacak iş yükü bulunamadı.', 'warn'); return; }
  const ctrl = new AbortController();
  runCtrl = ctrl;
  const settings = currentSettings();
  let done = 0;
  update((s) => {
    s.run = { ...idleRun(), active: true, kind: 'suite', total: ids.length, rounds: settings.mode === 'show' ? 1 : settings.repeat,
      totalRuns: ids.length * runsPerWorkload(settings), startedAt: performance.now(), mode: settings.mode };
  });
  try {
    for (let i = 0; i < ids.length; i++) {
      if (ctrl.signal.aborted) break;
      update((s) => {
        s.selected = ids[i];
        s.run.workloadId = ids[i];
        s.run.index = i + 1;
        s.run.round = 1;
        // Gerçekleşen koşu sayısını iş yükü sınırına hizala (başarısız turlar tahmini bozmasın)
        s.run.doneRuns = Math.max(s.run.doneRuns, i * runsPerWorkload(settings));
      });
      const ok = await runWorkload(ids[i], settings, ctrl.signal);
      if (ok) done++;
      if (!ctrl.signal.aborted && i < ids.length - 1) await sleep(SUITE_GAP_MS, ctrl.signal);
    }
    const complete = !ctrl.signal.aborted && done === ids.length;
    update((s) => { s.lastSuite = { ids, at: Date.now(), complete, settings }; }, { persist: true });
    if (ctrl.signal.aborted) toast(`Durduruldu — ${done}/${ids.length} test tamamlandı.`, 'warn');
    else if (complete) {
      toast('Tüm testler tamamlandı. Genel özet güncellendi.', 'ok');
      document.querySelector('.suite')?.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth', block: 'start' });
    } else toast(`${done}/${ids.length} test başarıyla tamamlandı.`, 'warn');
  } finally {
    if (runCtrl === ctrl) runCtrl = null;
    update((s) => {
      s.run = idleRun();
      // İptalde yarım kalan tur sonuçlarını gösterme; kayıtlı (medyan) sonuç görünsün
      if (ctrl.signal.aborted) for (const rt of RUNTIMES) if (!s.live[rt].aggregated) s.live[rt] = newLive();
      // Koşu bittiyse (ör. diğer taraf 409 verdi) "sırada / bağlanıyor" durumunda kalan kart olmasın
      for (const rt of RUNTIMES) if (['queued', 'connecting', 'warmup', 'measure'].includes(s.live[rt].phase)) s.live[rt] = newLive();
    });
  }
}

function stopRun() {
  if (!runCtrl) return;
  update((s) => { s.run.stopping = true; });
  runCtrl.abort(); // akışlar kapanır -> sunucu iptal eder
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

async function cleanMemory() {
  const res = await Promise.allSettled(RUNTIMES.map((rt) => collectGc(S.bases[rt])));
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  if (ok === 2) toast('İki runtime\'da da GC çalıştırıldı.', 'ok', 2200);
  else if (ok === 1) toast('Yalnızca bir runtime\'da GC çalıştırılabildi.', 'warn');
  else toast(res[0].reason?.kind === 'busy' ? 'Sunucular meşgul — test bitince tekrar deneyin.' : 'GC çağrısı başarısız oldu.', 'error');
}

/* ------------------------------------------------------------------ */
/* Görünüm modeli                                                       */
/* ------------------------------------------------------------------ */

const prefersReduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Örneklerin t değerini saniyeye çeviren çarpan (t ms mi sn mi? referans süreyle kıyaslayarak). */
function tToSeconds(samples, refMs) {
  const lastT = samples.length ? samples[samples.length - 1].t : undefined;
  if (!fmt.isNum(lastT) || lastT <= 0 || !(refMs > 0)) return 0.001;
  return lastT / refMs < 0.05 ? 1 : 0.001;
}

function sourceFor(rt) {
  const id = S.selected;
  const L = S.live[rt];
  if (L.workloadId === id && L.phase !== 'idle') return { kind: 'live', L, result: L.result, aggregated: !!L.aggregated };
  const pair = id ? S.results[id] : null;
  if (pair?.[rt]) return { kind: 'saved', result: pair[rt], at: pair.at, aggregated: true };
  return { kind: 'none' };
}

function elapsedMs(L) {
  if (L.phase !== 'measure' || !L.measureStartedAt) return undefined;
  return performance.now() - L.measureStartedAt;
}

function avg(arr, key) {
  let s = 0, n = 0;
  for (const x of arr) if (fmt.isNum(x[key])) { s += x[key]; n++; }
  return n ? s / n : undefined;
}

function runningHere() {
  return S.run.active && S.run.workloadId === S.selected;
}

function baseView(rt) {
  const src = sourceFor(rt);
  const conn = S.conn[rt];
  const label = conn.info?.runtimeLabel || S.live[rt].startInfo?.runtimeLabel || src.result?.runtimeLabel || S.infoSnapshot[rt]?.runtimeLabel || RT_NAME[rt];
  const info = conn.info || S.infoSnapshot[rt];
  const v = { label, src, final: false, stats: {}, chips: {}, crowns: new Set(), spread: null, cpuCount: fmt.isNum(info?.processorCount) ? info.processorCount : undefined };
  const fairRun = runningHere() && S.run.mode !== 'show';
  const roundTag = fairRun ? ` · tur ${S.live[rt].round || S.run.round}/${S.run.rounds}` : '';

  if (src.kind === 'none') {
    v.phase = conn.status === 'down' ? 'offline' : 'idle';
    v.note = conn.status === 'down' ? 'API\'ye bağlanılamadı — üstteki “Tekrar dene” ile yeniden deneyin.' : '';
    v.progress = 0;
    return v;
  }

  const pair = S.selected ? S.results[S.selected] : null;
  if (src.result) {
    const r = src.result;
    v.final = true;
    v.phase = src.kind === 'saved' ? 'saved' : 'done';
    v.progress = 1;
    v.allocated = r.allocatedBytes;
    v.stats = {
      duration: r.durationMs,
      gc: [r.gc0, r.gc1, r.gc2],
      cpuAvg: r.avgCpuPercent,
      gcPause: r.gcPauseMs,
      opsPerSec: r.opsPerSec,
      cpuTime: r.cpuTimeMs,
      peakWs: r.peakWorkingSetBytes,
      peakHeap: r.peakGcHeapBytes,
    };
    if (src.aggregated) {
      v.spread = r.spread && (r.n ?? 1) > 1 ? r.spread : null;
      const when = pair?.at ? fmt.dateTime(new Date(pair.at)) : '';
      if (pair?.mode === 'show') { v.note = `◐ ${SHOW_BADGE_TEXT} · ${when}`; v.noteKind = 'show'; }
      else if ((r.n ?? 1) < 2) { v.note = `${SINGLE_TEXT} · ${when}`; v.noteKind = 'single'; }
      else v.note = `Medyan · n = ${r.n} tur · ${when}`;
      if (pair?.mode !== 'show' && (r.n ?? 1) > 1) v.phaseText = `Medyan · ${r.n} tur`;
    } else if (fairRun) {
      v.phaseText = `Tur ${S.live[rt].round}/${S.run.rounds} tamam`;
      v.note = 'Tur sonucu — tüm turlar bitince medyan gösterilir.';
    }
    return v;
  }

  const L = src.L;
  v.phase = L.phase;
  v.progress = L.progress;
  v.note = L.error || '';
  if (L.phase === 'error' && L.errorKind === 'busy') v.phaseText = 'Sunucu meşgul';
  if (L.phase === 'queued') v.phaseText = `Sırada${roundTag}`;
  if (L.phase === 'warmup') v.phaseText = `Isınma turu…${roundTag}`;
  if (L.phase === 'measure') v.phaseText = `Ölçülüyor${roundTag}`;
  if (L.phase === 'connecting' && fairRun && S.run.cooling) v.phaseText = `Soğuma…${roundTag}`;
  const p = L.last;
  if (L.phase === 'measure' && p) {
    const el = elapsedMs(L);
    v.allocated = p.totalAllocatedBytes;
    v.stats = {
      duration: el,
      gc: [p.gc0, p.gc1, p.gc2],
      cpuAvg: avg(L.samples, 'cpuPercent'),
      gcPause: 'pending',
      opsPerSec: fmt.isNum(p.opsDone) && el > 0 ? p.opsDone / (el / 1000) : undefined,
      cpuTime: 'pending',
      peakWs: L.peakWs || undefined,
      peakHeap: L.peakHeap || undefined,
    };
  } else if (L.phase === 'measure') {
    v.stats = { duration: elapsedMs(L) };
  } else if (L.phase === 'warmup') {
    v.note = 'JIT ve katmanlı derleme ısınıyor; ölçüm birazdan başlayacak.';
  } else if (L.phase === 'queued') {
    v.note = fairRun ? 'Diğer runtime çalışıyor; kaynak paylaşımı olmasın diye sırasını bekliyor.' : '';
  }
  return v;
}

const CHIP_KEYS = ['allocated', 'duration', 'gc', 'gcPause', 'opsPerSec', 'cpuTime', 'peakWs', 'peakHeap'];

function buildViews() {
  const v10 = baseView('net10');
  const v11 = baseView('net11');

  // DIMM: iki runtime'ın büyüğüne göre oran (en az 1 hücre). Ölçüm sürerken ölçek, bilinen en büyük
  // toplamdır: diğer runtime'ın sonucu, bu iş yükünün kayıtlı sonuçları ve ilerlemeden öngörülen toplam
  // (tahsis ÷ ilerleme). Böylece çubuk ilk örnekte dolmaz, gerçek totalAllocatedBytes ile kademeli dolar.
  const a10 = fmt.isNum(v10.allocated) ? v10.allocated : 0;
  const a11 = fmt.isNum(v11.allocated) ? v11.allocated : 0;
  let maxA = Math.max(a10, a11);
  const liveRun = [v10, v11].some((v) => !v.final && v.allocated > 0);
  if (liveRun) {
    const saved = S.selected ? S.results[S.selected] : null;
    for (const rt of RUNTIMES) {
      const sv = saved?.[rt]?.allocatedBytes;
      if (fmt.isNum(sv) && saved.scale === S.settings.scale) maxA = Math.max(maxA, sv);
    }
    for (const v of [v10, v11]) {
      if (!v.final && v.allocated > 0 && v.progress >= 0.1) maxA = Math.max(maxA, v.allocated / v.progress);
      else if (!v.final && v.allocated > 0) maxA = Math.max(maxA, v.allocated * 10);
    }
  }
  for (const [v, a] of [[v10, a10], [v11, a11]]) {
    v.allocCells = a > 0 && maxA > 0 ? Math.max(1, Math.min(DIMM_CELL_COUNT, Math.round((a / maxA) * DIMM_CELL_COUNT))) : 0;
  }

  // Çipler ve taçlar yalnızca iki tarafın da kesinleşmiş (toplanmış) sonucu varken; koşu sürerken gösterilmez.
  if (v10.final && v11.final && v10.src.aggregated && v11.src.aggregated && !runningHere()) {
    const r10 = v10.src.result;
    const r11 = v11.src.result;
    const pair = S.results[S.selected];
    // Tek ölçüm / gösteri modunda oynaklık bilinmez: taç ve "Daha hızlı" rozeti verilmez (çipler kalır)
    const tentative = pair?.mode === 'show' || sampleCount(r10, r11) < 2;
    for (const key of CHIP_KEYS) {
      const c = metricChip(r10, r11, key, { short: true });
      if (c.verdict === 'na') continue;
      v11.chips[key] = c;
      if (tentative) continue;
      if (c.verdict === 'better') v11.crowns.add(key);
      if (c.verdict === 'worse') v10.crowns.add(key);
    }
    const d = pairMetrics(r10, r11).duration.verdict;
    v11.winner = !tentative && d === 'better';
    v10.winner = !tentative && d === 'worse';
    v11.single = pair?.mode !== 'show' && sampleCount(r10, r11) < 2;
  }
  return { net10: v10, net11: v11 };
}

function chartSeries(views) {
  const cpu = [];
  const mem = [];
  let xMax = 0;
  for (const rt of RUNTIMES) {
    const v = views[rt];
    let samples = [];
    let refMs;
    let live = false;
    if (v.src.kind === 'live' && v.src.L.samples.length) {
      samples = v.src.L.samples;
      refMs = v.src.L.result?.durationMs ?? elapsedMs(v.src.L);
      live = v.phase === 'measure';
    } else if (v.src.result?.samples?.length) {
      samples = v.src.result.samples;
      refMs = v.src.result.durationMs;
    }
    const k = tToSeconds(samples, refMs);
    const pts = (key) => samples
      .map((s, i) => [fmt.isNum(s.t) ? s.t * k : i * 0.2, s[key]])
      .filter(([x, y]) => fmt.isNum(x) && fmt.isNum(y));
    const cpuPts = pts('cpuPercent');
    const wsPts = pts('workingSetBytes');
    const heapPts = pts('gcHeapBytes');
    for (const p of [...cpuPts, ...wsPts]) if (p[0] > xMax) xMax = p[0];
    cpu.push({ key: rt, color: COLORS[rt], points: cpuPts, area: true, live });
    mem.push({ key: `${rt}-ws`, color: COLORS[rt], points: wsPts, area: true, live });
    mem.push({ key: `${rt}-heap`, color: COLORS[rt], points: heapPts, dash: '5 5', width: 1.6, glow: false, live });
  }
  return { cpu: { series: cpu, xMax }, mem: { series: mem, xMax } };
}

/* ------------------------------------------------------------------ */
/* Render                                                               */
/* ------------------------------------------------------------------ */

let chartKey = '';
let lastChartAt = 0;
const CHART_MIN_MS = 250;

function render() {
  document.body.classList.toggle('presenting', S.presenting);
  document.body.classList.toggle('running', S.run.active);
  $('btn-present').setAttribute('aria-pressed', String(S.presenting));

  renderConn();
  renderCpuNote();
  renderHeroMeta();
  renderLimits();
  renderPicker();
  renderControls();

  const views = buildViews();
  cards.net10.update(views.net10);
  cards.net11.update(views.net11);
  renderStage(views);

  // Grafikler: yalnızca veri değişince yeniden çiz
  const key = RUNTIMES.map((rt) => {
    const v = views[rt];
    return `${v.src.kind}:${v.phase}:${v.src.L?.samples.length ?? 0}:${v.src.result?.durationMs ?? ''}:${v.src.L?.round ?? ''}`;
  }).join('|') + S.selected;
  // Ölçüm sürerken grafik en fazla ~4 kez/sn yeniden çizilir (tarayıcı, ölçülen makineyle aynı CPU'yu paylaşır)
  const liveNow = RUNTIMES.some((rt) => views[rt].phase === 'measure');
  if (key !== chartKey && (!liveNow || performance.now() - lastChartAt >= CHART_MIN_MS)) {
    chartKey = key;
    lastChartAt = performance.now();
    const cs = chartSeries(views);
    cpuChart.update(cs.cpu);
    memChart.update(cs.mem);
  }

  const wl = S.workloads.find((w) => w.id === S.selected);
  const pair = S.selected ? S.results[S.selected] : null;
  renderVerdict($('verdict'), runningHere() ? null : pair, wl);
  renderSuiteIfChanged();
  renderMethod();
  if (!$('card-overlay').hidden) renderSlideIfChanged();
}

function currentInfos() {
  return { net10: S.conn.net10.info || S.infoSnapshot.net10, net11: S.conn.net11.info || S.infoSnapshot.net11 };
}

function renderConn() {
  const box = $('conn');
  if (!box._built) {
    box._built = true;
    for (const rt of RUNTIMES) {
      const retry = h('button', { type: 'button', class: 'pill-retry', onclick: () => checkConnection(rt).then((ok) => ok && loadWorkloads()) }, '↻ Tekrar dene');
      const pill = h('div', { class: `pill pill-${rt}` },
        h('span', { class: 'pill-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'pill-name' }, RT_NAME[rt]),
        h('span', { class: 'pill-status' }, '…'),
        retry);
      box.appendChild(pill);
      box[`_${rt}`] = pill;
    }
    box._eq = h('div', { class: 'pill pill-eq', hidden: true });
    box.appendChild(box._eq);
  }
  for (const rt of RUNTIMES) {
    const pill = box[`_${rt}`];
    const st = S.conn[rt].status;
    pill.dataset.status = st;
    const txt = st === 'up' ? 'bağlı' : st === 'busy' ? 'bağlı · meşgul' : st === 'down' ? 'bağlantı yok' : 'kontrol ediliyor…';
    setText(pill.querySelector('.pill-status'), txt);
    pill.title = st === 'down' ? `${S.bases[rt]} — ${S.conn[rt].error || ''}` : S.bases[rt];
    pill.querySelector('.pill-retry').hidden = st !== 'down';
  }
  // Eşit kaynak göstergesi: iki /api/info yanıtındaki processorCount + memoryLimitBytes
  const lm = limitsMatch(S.conn.net10.info, S.conn.net11.info);
  const eq = box._eq;
  eq.hidden = lm === null;
  eq.dataset.status = lm ? 'eq' : 'neq';
  setText(eq, lm ? 'eşit kaynak ✓' : '⚠ kaynaklar eşit değil');
  eq.title = lm ? `İki konteyner aynı CPU sayısını ve aynı ${GC_LIMIT_LABEL}nı bildiriyor ${GC_LIMIT_HINT}` : `İki konteynerin bildirdiği CPU sayısı veya ${GC_LIMIT_LABEL} farklı ${GC_LIMIT_HINT}`;
}

function renderCpuNote() {
  const { net10: i10, net11: i11 } = currentInfos();
  const c10 = fmt.isNum(i10?.processorCount) ? i10.processorCount : null;
  const c11 = fmt.isNum(i11?.processorCount) ? i11.processorCount : null;
  let n = '';
  if (c10 !== null && c11 !== null && c10 !== c11) n = ` (.NET 10: ${c10} · .NET 11: ${c11} çekirdek)`;
  else if (c10 !== null || c11 !== null) n = ` (${c10 ?? c11} çekirdek)`;
  setText($('cpu-note'), `% = konteynerdeki tüm çekirdekler üzerinden${n}`);
}

function limitStr(i) {
  if (!i) return '—';
  return `${fmt.isNum(i.processorCount) ? i.processorCount + ' vCPU' : '? vCPU'} / ${fmt.isNum(i.memoryLimitBytes) && i.memoryLimitBytes > 0 ? `${fmt.bytes(i.memoryLimitBytes)} ${GC_LIMIT_LABEL}` : `${GC_LIMIT_LABEL} yok`}`;
}

function renderLimits() {
  const box = $('limits-warn');
  const i10 = S.conn.net10.info;
  const i11 = S.conn.net11.info;
  const lm = limitsMatch(i10, i11);
  box.hidden = lm !== false;
  if (lm === false) {
    setText(box.querySelector('.lw-detail'), `.NET 10: ${limitStr(i10)} · .NET 11: ${limitStr(i11)} — sonuçlar doğrudan karşılaştırılabilir değil.`);
  }
}

function renderHeroMeta() {
  const i = S.conn.net11.info || S.conn.net10.info || S.infoSnapshot.net11 || S.infoSnapshot.net10;
  const parts = [];
  if (i) parts.push(infoLine(i));
  const lm = limitsMatch(S.conn.net10.info, S.conn.net11.info);
  if (lm === true) parts.push('iki konteynerde aynı limitler');
  setText($('hero-meta'), parts.join('  ·  '));
}

function renderPicker() {
  const grid = $('workloads');
  const key = JSON.stringify([S.workloads.map((w) => [w.id, w.on10, w.on11]), S.selected, S.run.active, S.run.workloadId, S.workloadsError, resultsVersion, Object.keys(S.results).length]);
  if (key === lastPickerKey) return;
  lastPickerKey = key;

  if (!S.workloads.length) {
    grid.replaceChildren(h('div', { class: 'wl-empty' },
      S.workloadsError ? `${S.workloadsError}. Bağlantı kurulunca liste otomatik yüklenecek.` : 'İş yükleri yükleniyor…'));
    return;
  }
  grid.replaceChildren(...S.workloads.map((w, idx) => {
    const sel = w.id === S.selected;
    const pair = S.results[w.id];
    const sp = pair ? metricChip(pair.net10, pair.net11, 'duration') : null;
    const missing = w.on10 === false ? '.NET 10\'da yok' : w.on11 === false ? '.NET 11\'de yok' : '';
    return h('button', {
      type: 'button',
      class: `wl${sel ? ' sel' : ''}${S.run.active && S.run.workloadId === w.id ? ' running' : ''}`,
      role: 'radio',
      'aria-checked': String(sel),
      tabindex: sel || (!S.selected && idx === 0) ? '0' : '-1',
      disabled: S.run.active ? true : null,
      dataset: { id: w.id },
      onclick: () => selectWorkload(w.id),
    },
    h('span', { class: 'wl-icon', 'aria-hidden': 'true' }, w.icon || '•'),
    h('span', { class: 'wl-text' },
      h('span', { class: 'wl-title' }, w.titleTr),
      h('span', { class: 'wl-desc' }, w.descriptionTr || w.title || '')),
    h('span', { class: 'wl-foot mono' },
      h('span', { class: 'wl-cat' }, w.category || ''),
      missing ? h('span', { class: 'wl-miss' }, missing) : null,
      sp && sp.verdict !== 'na' ? h('span', { class: `wl-res chip chip-${sp.verdict}`, title: pair.mode === 'show' ? SHOW_BADGE_TEXT : `n = ${sampleCount(pair.net10, pair.net11)}` }, sp.verdict === 'noise' ? '≈ hassasiyet içinde' : sp.text) : null));
  }));
}

function selectWorkload(id) {
  if (S.run.active) return;
  update((s) => { s.selected = id; }, { persist: true });
}

function renderControls() {
  const busy = S.run.active;
  for (const seg of document.querySelectorAll('.seg')) {
    const setting = seg.dataset.setting;
    for (const b of seg.querySelectorAll('button')) {
      const on = String(S.settings[setting]) === b.dataset.value;
      b.setAttribute('aria-pressed', String(on));
      toggle(b, 'on', on);
      b.disabled = busy;
    }
  }
  $('grp-repeat').hidden = S.settings.mode === 'show';
  const sw = $('warmup');
  sw.setAttribute('aria-checked', String(S.settings.warmup));
  setText(sw.querySelector('.switch-text'), S.settings.warmup ? 'Açık' : 'Kapalı');
  sw.disabled = busy;

  const anyUp = RUNTIMES.every((rt) => S.conn[rt].status !== 'down');
  $('btn-start').disabled = busy || !S.selected || !anyUp;
  $('btn-suite').disabled = busy || !S.workloads.length || !anyUp;
  $('btn-stop').disabled = !busy || S.run.stopping;
  $('btn-gc').disabled = busy;
  setText($('btn-stop'), S.run.stopping ? '⏹ Durduruluyor…' : '⏹ Durdur');

  const hint = $('mode-hint');
  if (S.settings.mode === 'show') {
    hint.dataset.kind = 'show';
    setText(hint, 'Kaynaklar paylaşıldığı için süre ve CPU değerleri birbirini etkiler; sunum içindir, kesin sayı için Adil ölçüm\'ü kullanın.');
  } else {
    hint.dataset.kind = 'fair';
    const n = S.settings.repeat;
    setText(hint, n > 1
      ? `Adil ölçüm: runtime'lar tek tek çalışır, ${n} tur, sıra her turda değişir (10→11, 11→10…), her koşudan önce GC + kısa soğuma; sonuç turların medyanıdır.`
      : 'Adil ölçüm, tek tur: oynaklık bilinemez — güvenilir fark için 3 veya 5 tekrar seçin.');
  }
}

function etaText() {
  const r = S.run;
  if (!r.active || !r.totalRuns) return '';
  if (r.doneRuns < 1 || !r.lastDoneAt) return 'kalan süre hesaplanıyor…';
  // Tamamlanan koşuların ortalaması × kalan koşu − şu anki koşuda geçen süre
  const per = (r.lastDoneAt - r.startedAt) / r.doneRuns;
  const left = r.totalRuns - r.doneRuns;
  const remain = Math.max(0, per * left - (performance.now() - r.lastDoneAt), per * (left - 1));
  if (remain < 1500) return 'neredeyse bitti';
  const s = Math.round(remain / 1000);
  return s < 60 ? `~${s} sn kaldı` : `~${Math.round(s / 60)} dk kaldı`;
}

function renderStage(views) {
  const wl = S.workloads.find((w) => w.id === S.selected);
  const t = $('stage-title');
  const key = `${wl?.id}|${wl?.titleTr}`;
  if (t._key !== key) {
    t._key = key;
    t.replaceChildren(
      h('span', { class: 'st-icon', 'aria-hidden': 'true' }, wl?.icon || '◆'),
      h('span', { class: 'st-text' },
        h('span', { class: 'st-name' }, wl?.titleTr || 'İş yükü seçilmedi'),
        h('span', { class: 'st-desc' }, wl?.descriptionTr || '')));
  }
  let status;
  if (S.run.active) {
    const parts = [];
    if (S.run.kind === 'suite') parts.push(`Test ${S.run.index}/${S.run.total}`);
    if (S.run.mode !== 'show') parts.push(`Tur ${S.run.round}/${S.run.rounds}`);
    const phases = RUNTIMES.map((rt) => views[rt].phase);
    parts.push(S.run.cooling ? 'soğuma…' : phases.includes('warmup') ? 'ısınma turu…' : phases.includes('measure') ? 'ölçülüyor' : 'bağlanıyor…');
    parts.push(S.run.mode === 'show' ? 'gösteri' : 'adil ölçüm');
    const eta = etaText();
    if (eta) parts.push(eta);
    status = S.run.stopping ? 'Durduruluyor…' : parts.join(' · ');
  } else {
    status = 'Hazır';
  }
  setText($('stage-status'), status);
  toggle($('stage-status'), 'live', S.run.active);
  const bar = $('run-progress');
  const frac = S.run.active && S.run.totalRuns ? Math.min(1, S.run.doneRuns / S.run.totalRuns) : 0;
  bar.hidden = !S.run.active;
  bar.firstElementChild.style.width = `${(frac * 100).toFixed(1)}%`;
}

function renderSuiteIfChanged() {
  const key = `${resultsVersion}|${Object.keys(S.results).length}|${S.workloads.length}|${S.run.active}`;
  if (key === lastSuiteKey) return;
  lastSuiteKey = key;
  const summary = computeSummary(S.results, S.workloads.map((w) => w.id));
  renderSuite($('suite'), summary, new Map(S.workloads.map((w) => [w.id, w])), {
    onOpenCard: openCard,
    onClear: () => {
      if (!confirm('Kayıtlı tüm sonuçlar silinsin mi?')) return;
      update(() => { clearSaved(); resultsVersion++; });
    },
    running: S.run.active,
  });
}

function renderSlideIfChanged() {
  const key = `${resultsVersion}|${Object.keys(S.results).length}|${S.workloads.length}|${S.conn.net10.info?.runtimeLabel}|${S.conn.net11.info?.runtimeLabel}`;
  if (key === lastSlideKey) return;
  lastSlideKey = key;
  const summary = computeSummary(S.results, S.workloads.map((w) => w.id));
  renderSlide($('slide'), summary, currentInfos(), new Map(S.workloads.map((w) => [w.id, w])));
}

function latestPair() {
  let best = null;
  for (const p of Object.values(S.results)) if (!best || (p.at || 0) > (best.at || 0)) best = p;
  return best;
}

function renderMethod() {
  const { net10: i10, net11: i11 } = currentInfos();
  const lp = latestPair();
  const key = JSON.stringify([i10, i11, lp?.at, S.settings.mode, S.settings.repeat]);
  if (key === lastMethodKey) return;
  lastMethodKey = key;

  const yes = (b) => (b === true ? 'açık' : b === false ? 'kapalı' : '—');
  const gcMode = (i) => (i?.gc ? `${i.gc.server ? 'Server' : 'Workstation'} GC · eşzamanlı ${yes(i.gc.concurrent)}${fmt.isNum(i.gc.heapHardLimit) && i.gc.heapHardLimit > 0 ? ` · heap sınırı ${fmt.bytes(i.gc.heapHardLimit)}` : ''}` : '—');
  const rows = [
    ['Runtime', (i) => i?.runtimeLabel || '—', false],
    ['Framework', (i) => i?.frameworkDescription || '—', false],
    ['Hedef (TFM)', (i) => i?.tfm || '—', false],
    ['İşletim sistemi', (i) => [i?.os, i?.arch].filter(Boolean).join(' · ') || '—', true],
    ['İşlemci', (i) => (fmt.isNum(i?.processorCount) ? `${i.processorCount} vCPU` : '—'), true],
    [`${GC_LIMIT_LABEL} ${GC_LIMIT_HINT}`, (i) => (fmt.isNum(i?.memoryLimitBytes) && i.memoryLimitBytes > 0 ? fmt.bytes(i.memoryLimitBytes) : '—'), true],
    ['GC modu', gcMode, true],
    ['Katmanlı derleme / PGO', (i) => `${yes(i?.tieredCompilation)} / ${yes(i?.tieredPgo)}`, true],
  ];
  const table = h('div', { class: 'mtable', role: 'table', 'aria-label': 'Çalışma ortamı' },
    h('div', { class: 'mrow2 mhead', role: 'row' }, h('span', { role: 'columnheader' }, ''), h('span', { role: 'columnheader', class: 'c10' }, '.NET 10'), h('span', { role: 'columnheader', class: 'c11' }, '.NET 11')),
    ...rows.map(([label, f, mustMatch]) => {
      const a = f(i10);
      const b = f(i11);
      return h('div', { class: `mrow2${mustMatch && a !== b ? ' differ' : ''}`, role: 'row' },
        h('span', { role: 'rowheader' }, label), h('span', { class: 'mono', role: 'cell' }, a), h('span', { class: 'mono', role: 'cell' }, b));
    }));

  const pre = /rc|preview|alpha|beta/i.test(i11?.runtimeLabel || '');
  const lm = limitsMatch(i10, i11);
  const usedMode = lp ? lp.mode : S.settings.mode;
  const usedRep = lp ? (lp.mode === 'show' ? 1 : (lp.n ?? lp.repeat ?? 1)) : S.settings.repeat;
  const modeLine = usedMode === 'show'
    ? 'Son sonuç “Gösteri (aynı anda)” modunda üretildi: iki runtime eşzamanlı çalıştığı için bellek bant genişliği, önbellek, güç/ısı bütçesi ve Docker VM\'inin vCPU zamanlaması paylaşılır; hızlı olan bitince yavaş olan makineyi tek başına kullanır ve fark olduğundan küçük görünür. Bu mod sunum içindir, kesin ölçüm değildir.'
    : `Son sonuç “Adil ölçüm” modunda üretildi: runtime\'lar tek tek çalışır (asla aynı anda değil), ${usedRep} tur; sıra her turda dönüşümlüdür (10→11, 11→10, …) böylece sıra ve ısınma/ısı kayması etkisi dengelenir. Her koşudan önce iki tarafta GC.Collect çağrılır ve ~1,5 sn beklenir.`;
  const notes = [
    lm === true ? h('li', {}, `Eşit kaynak: iki API de aynı CPU sayısını ve aynı ${GC_LIMIT_LABEL}nı bildiriyor (/api/info). ${GC_LIMIT_LABEL}, GC'nin kullanabileceği bellektir ${GC_LIMIT_HINT}; konteyner limitinin kendisi değildir.`)
      : lm === false ? h('li', { class: 'warn' }, `⚠ Kaynak sınırları eşit değil: iki konteynerin bildirdiği CPU sayısı veya ${GC_LIMIT_LABEL} farklı — karşılaştırma adil değildir.`)
        : h('li', {}, 'Konteyner limitleri henüz okunamadı (API bağlantısı bekleniyor).'),
    h('li', {}, modeLine),
    h('li', {}, 'Toplama: süre, CPU zamanı, CPU ortalaması, GC duraklaması, işlem/sn, tahsis edilen bellek ve GC sayaçları için turların MEDYANI kullanılır; değerin yanında min–max aralığı gösterilir.'),
    h('li', {}, 'Gürültü tabanı: iki runtime arasındaki fark, turlar arası oynaklıktan (her runtime\'ın göreli min–max aralığı) küçükse kazanan ilan edilmez — “fark ölçüm hassasiyeti içinde” yazar. ±%3 içindeki farklar “aynı” sayılır. Tek turda oynaklık bilinemez: “tek ölçüm — tekrar edin”.'),
    h('li', {}, 'Genel hız, medyan süre oranlarının geometrik ortalamasıdır; gösteri modundaki sonuçlar, adil ölçüm sonucu varken özete katılmaz. Genel özet, toplam/ortalama farkı testlerin çoğunda tek tek doğrulanmıyorsa (çoğu “hassasiyet içinde” ya da yönler karışık) kazanan ilan etmez; tek turluk sonuçlar “tek ölçüm” diye işaretlenir.'),
    h('li', {}, 'CPU yüzdesi konteynerdeki tüm çekirdekler üzerindendir: 2 çekirdekli bir konteynerde tek iş parçacıklı bir iş yükü en fazla ≈ %50 gösterir. Bu yüzden CPU ORT. değerinin altında çekirdek eşdeğeri (≈ 1,0 çekirdek gibi) verilir.'),
    h('li', {}, 'A/A kontrolü: iki yuvayı aynı runtime\'a yönlendirerek (ör. ', h('code', {}, '?b10=/bench11&b11=/bench11'), ') düzeneğin taraflı olmadığını doğrulayabilirsiniz; Adil ölçüm modunda farkların “hassasiyet içinde” çıkması beklenir.'),
    pre ? h('li', {}, '.NET 11 bir ön sürümdür (RC/preview); nihai sürümde sonuçlar değişebilir.') : null,
    h('li', {}, 'Aynı iş yükü kodu iki runtime için ayrı ayrı derlenir; DOTNET_* ayar değişkeni verilmez, her runtime kendi varsayılanlarıyla çalışır. Isınma turu açıkken ilk tur ölçüme katılmaz (JIT/katmanlı derleme etkisi azalır).'),
    h('li', {}, 'Checksum, iş yükünün ürettiği sonucun özetidir; eşleşmesi iki runtime\'ın aynı işi yaptığını gösterir.'),
    h('li', {}, 'Sonuçlar bu makinede, Docker içinde ölçülmüştür. Docker Desktop (ör. macOS) konteynerleri bir Linux sanal makinesinde çalıştırır; mutlak değerler çıplak donanımdan farklı olabilir, karşılaştırma görelidir.'),
  ].filter(Boolean);

  $('method-body').replaceChildren(table, h('ul', { class: 'mnotes' }, ...notes));
}

/* ------------------------------------------------------------------ */
/* Canlı saat: ölçüm sırasında SÜRE ve kalan süreyi akıcı güncelle      */
/* ------------------------------------------------------------------ */

setInterval(() => {
  if (S.run.active || RUNTIMES.some((rt) => S.live[rt].phase === 'measure')) update(() => {});
}, 100);

/* ------------------------------------------------------------------ */
/* Etkileşimler                                                         */
/* ------------------------------------------------------------------ */

function bindControls() {
  for (const seg of document.querySelectorAll('.seg')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || S.run.active) return;
      const setting = seg.dataset.setting;
      const value = setting === 'scale' || setting === 'repeat' ? Number(b.dataset.value) : b.dataset.value;
      update((s) => { s.settings[setting] = value; }, { persist: true });
    });
  }
  $('warmup').addEventListener('click', () => {
    if (S.run.active) return;
    update((s) => { s.settings.warmup = !s.settings.warmup; }, { persist: true });
  });
  $('btn-start').addEventListener('click', startSingle);
  $('btn-suite').addEventListener('click', startSuite);
  $('btn-stop').addEventListener('click', stopRun);
  $('btn-gc').addEventListener('click', cleanMemory);
  $('btn-present').addEventListener('click', () => setPresenting(!S.presenting));
  $('btn-card').addEventListener('click', openCard);
  $('btn-card-close').addEventListener('click', closeCard);
  $('btn-card-print').addEventListener('click', () => window.print());
  $('btn-download').addEventListener('click', downloadJson);
  $('card-overlay').addEventListener('click', (e) => { if (e.target === $('card-overlay')) closeCard(); });

  // Radyo grubu ok tuşları
  $('workloads').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    moveSelection(e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1, true);
  });

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && S.presenting && presentingFs) { presentingFs = false; setPresenting(false); }
  });

  // Yazdırırken metodoloji açık olsun
  const details = document.querySelector('.method details');
  let wasOpen = false;
  window.addEventListener('beforeprint', () => { wasOpen = details.open; details.open = true; });
  window.addEventListener('afterprint', () => { details.open = wasOpen; });
}

function moveSelection(delta, focus) {
  if (S.run.active || !S.workloads.length) return;
  const i = Math.max(0, S.workloads.findIndex((w) => w.id === S.selected));
  const next = S.workloads[(i + delta + S.workloads.length) % S.workloads.length];
  selectWorkload(next.id);
  if (focus) requestAnimationFrame(() => requestAnimationFrame(() => $('workloads').querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.focus()));
}

let presentingFs = false;
function setPresenting(on) {
  update((s) => { s.presenting = on; });
  if (on) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => { presentingFs = true; }).catch(() => {});
    }
  } else if (document.fullscreenElement && presentingFs) {
    presentingFs = false;
    document.exitFullscreen().catch(() => {});
  }
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    const overlayOpen = !$('card-overlay').hidden;
    if (e.key === 'Escape') {
      if (overlayOpen) { closeCard(); e.preventDefault(); return; }
      if (S.presenting) { setPresenting(false); e.preventDefault(); }
      return;
    }
    if (overlayOpen) return;
    if (e.key === 'p' || e.key === 'P') { setPresenting(!S.presenting); e.preventDefault(); }
    else if ((e.key === 'r' || e.key === 'R') && !S.run.active) { startSingle(); e.preventDefault(); }
    else if (S.presenting && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { moveSelection(e.key === 'ArrowRight' ? 1 : -1, false); e.preventDefault(); }
  });
}

let lastFocus = null;
function openCard() {
  lastFocus = document.activeElement;
  $('card-overlay').hidden = false;
  document.body.classList.add('card-open');
  lastSlideKey = '';
  renderSlideIfChanged();
  $('btn-card-close').focus();
}

function closeCard() {
  $('card-overlay').hidden = true;
  document.body.classList.remove('card-open');
  lastFocus?.focus?.();
}

function downloadJson() {
  const summary = computeSummary(S.results, S.workloads.map((w) => w.id));
  const data = {
    olusturan: '.NET 10 vs .NET 11 karşılaştırma paneli',
    disaAktarim: new Date().toISOString(),
    tabanAdresler: S.bases,
    ortam: currentInfos(),
    alanAciklamalari: {
      'ortam.*.memoryLimitBytes': `${GC_LIMIT_LABEL} — GC'nin kullanabileceği bellek ${GC_LIMIT_HINT}; konteyner limitinin kendisi değil`,
      'ortam.*.processorCount': 'Konteynere ayrılan çekirdek sayısı',
      'sonuclar.*.*.avgCpuPercent': 'Ortalama CPU yüzdesi, konteynerdeki TÜM çekirdekler üzerinden (çekirdek eşdeğeri = avgCpuPercent ÷ 100 × processorCount)',
      'sonuclar.*.*.durationMs': 'Ölçüm süresi (ms), adil ölçümde turların medyanı',
      'sonuclar.*.*.allocatedBytes': 'Ölçüm boyunca tahsis edilen toplam bellek (bayt)',
    },
    esitKaynak: limitsMatch(S.conn.net10.info, S.conn.net11.info),
    ayarlar: S.settings,
    olcumYontemi: {
      fair: 'Adil ölçüm: sırayla, N tur, dönüşümlü sıra (10→11, 11→10, …), her koşudan önce GC.Collect + ~1,5 sn soğuma; net10/net11 alanları turların medyanıdır, spread = [min, max], rounds = ham tur sonuçları.',
      show: 'Gösteri: iki runtime aynı anda; kaynaklar paylaşılır, kesin ölçüm değildir.',
      gurultuTabani: 'Fark, her runtime\'ın göreli min–max aralığından küçükse "fark ölçüm hassasiyeti içinde" sayılır.',
    },
    isYukleri: S.workloads,
    sonuclar: S.results,
    ozet: {
      testSayisi: summary.usedN,
      tekrar: summary.repText,
      yalnizcaGosteriModu: summary.showOnly,
      ozeteDahilOlmayanGosteriTesti: summary.excludedShow,
      geometrikOrtalamaHizOrani: fmt.isNum(summary.geoSpeedup) ? summary.geoSpeedup : null,
      genelHizHukmu: summary.speed?.verdict ?? null, // better | worse | equal | noise (hassasiyet içinde) | na
      tekOlcum: summary.minRep < 2,
      net11OndeOlduguTest: summary.wins,
      net10OndeOlduguTest: summary.losses,
      berabere: summary.ties,
      hassasiyetIcinde: summary.noisy,
      toplamTahsis: { net10: summary.alloc10, net11: summary.alloc11 },
      toplamGc: { net10: summary.gc10, net11: summary.gc11 },
      toplamCpuMs: { net10: summary.cpu10, net11: summary.cpu11 },
      checksumEslesen: summary.checksumOk,
      checksumFarkli: summary.checksumBad,
    },
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const a = h('a', { href: url, download: `dotnet10-vs-11-sonuclar-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (!summary.n) toast('Henüz sonuç yok — dosya yalnızca ortam bilgisini içeriyor.', 'warn');
}

/* ------------------------------------------------------------------ */
/* Bildirimler                                                          */
/* ------------------------------------------------------------------ */

function toast(message, kind = 'info', ms = 5000) {
  const box = $('toasts');
  // Aynı mesaj zaten görünüyorsa tekrar etme
  for (const t of box.children) if (t.textContent === message) return;
  const t = h('div', { class: `toast toast-${kind}` }, message);
  box.appendChild(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 350);
  }, ms);
}

window.addEventListener('beforeunload', () => runCtrl?.abort());
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof ApiError) e.preventDefault();
});
