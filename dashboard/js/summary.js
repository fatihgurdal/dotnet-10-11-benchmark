// Gerçek sonuçlardan toplama (medyan), gürültü tabanı ve genel özet hesaplama.
// Uydurma veri yok: yalnızca API'den gelen result nesneleri kullanılır.

import { compare, gcTotal, isNum, speedPhrase, lessPhrase, morePhrase, arrowPhrase, int, EQUAL_BAND } from './format.js';

/* ------------------------------------------------------------------ */
/* Turları toplama: medyan + min–max aralığı                            */
/* ------------------------------------------------------------------ */

export const AGG_FIELDS = ['durationMs', 'cpuTimeMs', 'avgCpuPercent', 'allocatedBytes', 'gc0', 'gc1', 'gc2', 'gcPauseMs',
  'peakWorkingSetBytes', 'peakGcHeapBytes', 'ops', 'opsPerSec'];

export function median(values) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Bir runtime'ın tur sonuçlarını tek bir medyan sonuca indirger. */
export function aggregateRuns(list) {
  const runs = list.filter(Boolean);
  if (!runs.length) return null;
  const out = { n: runs.length, spread: {} };
  for (const f of AGG_FIELDS) {
    const vals = runs.map((r) => r[f]).filter(isNum);
    out[f] = median(vals);
    if (vals.length > 1) out.spread[f] = [Math.min(...vals), Math.max(...vals)];
  }
  const gcs = runs.map(gcTotal).filter(isNum);
  if (gcs.length > 1) out.spread.gcTotal = [Math.min(...gcs), Math.max(...gcs)];
  out.runtimeLabel = runs.find((r) => r.runtimeLabel)?.runtimeLabel;
  out.workloadId = runs[0].workloadId;
  out.scale = runs[0].scale;
  out.warmup = runs[0].warmup;
  const sums = runs.map((r) => r.checksum).filter((c) => c !== undefined && c !== null);
  out.checksumConsistent = sums.every((c) => String(c) === String(sums[0]));
  out.checksum = out.checksumConsistent ? sums[0] : undefined;
  // Grafikler için: süresi medyana en yakın turun örnekleri
  let best = runs[0];
  for (const r of runs) if (Math.abs((r.durationMs ?? 0) - out.durationMs) < Math.abs((best.durationMs ?? 0) - out.durationMs)) best = r;
  out.samples = best.samples || [];
  return out;
}

/* ------------------------------------------------------------------ */
/* Karşılaştırma + gürültü tabanı                                       */
/* ------------------------------------------------------------------ */

const METRICS = {
  duration: { field: 'durationMs', lower: true },
  allocated: { field: 'allocatedBytes', lower: true },
  gc: { field: 'gcTotal', lower: true },
  cpuTime: { field: 'cpuTimeMs', lower: true },
  gcPause: { field: 'gcPauseMs', lower: true },
  opsPerSec: { field: 'opsPerSec', lower: false },
  peakWs: { field: 'peakWorkingSetBytes', lower: true },
  peakHeap: { field: 'peakGcHeapBytes', lower: true },
};

function value(r, field) {
  if (!r) return undefined;
  return field === 'gcTotal' ? gcTotal(r) : r[field];
}

/** Göreli aralık (max-min)/medyan — bir runtime'ın kendi içindeki ölçüm oynaklığı */
function relRange(r, field) {
  const s = r?.spread?.[field];
  const m = value(r, field);
  if (!s || !isNum(m) || m <= 0) return 0;
  return (s[1] - s[0]) / m;
}

export function sampleCount(r10, r11) {
  return Math.min(r10?.n ?? 1, r11?.n ?? 1);
}

/**
 * Bir metrik için hüküm: 'better' | 'worse' | 'equal' | 'noise' | 'na'
 * - ±%3 içi: 'equal'
 * - fark, turlar arası oynaklıktan (göreli min–max aralığı) küçükse: 'noise' (kazanan ilan edilmez)
 * single=true: tek ölçüm (oynaklık bilinmiyor)
 */
export function judge(r10, r11, key) {
  const m = METRICS[key];
  const a = value(r10, m.field);
  const b = value(r11, m.field);
  const c = compare(a, b, m.lower);
  const n = sampleCount(r10, r11);
  if (c.verdict === 'na' || c.verdict === 'equal') return { ...c, n, single: n < 2 };
  if (n < 2) return { ...c, n, single: true };
  const noise = Math.max(relRange(r10, m.field), relRange(r11, m.field));
  const lo = Math.min(a, b);
  const diff = lo > 0 ? Math.abs(a - b) / lo : Infinity;
  if (diff <= noise) return { verdict: 'noise', factor: c.factor, n, noise, single: false };
  return { ...c, n, noise, single: false };
}

const NOISE_TEXT = 'fark ölçüm hassasiyeti içinde';

/** Çip metni + hüküm (tüm görünümler bu tek fonksiyonu kullanır) */
export function metricChip(r10, r11, key, { short = false } = {}) {
  const j = judge(r10, r11, key);
  if (j.verdict === 'na') return j;
  if (j.verdict === 'noise') return { ...j, text: NOISE_TEXT };
  const m = METRICS[key];
  const a = value(r10, m.field);
  const b = value(r11, m.field);
  let p;
  switch (key) {
    case 'duration': p = speedPhrase(a, b); break;
    case 'allocated': p = lessPhrase(a, b, 'tahsis'); break;
    case 'gc': p = arrowPhrase('GC', a, b, int); if (p.verdict === 'equal') p.text = 'GC ≈ aynı'; break;
    case 'cpuTime': p = lessPhrase(a, b, short ? 'CPU' : 'CPU zamanı'); break;
    case 'gcPause': p = lessPhrase(a, b, 'duraklama'); break;
    case 'opsPerSec': p = morePhrase(a, b, 'işlem/sn'); break;
    case 'peakWs': p = lessPhrase(a, b, 'bellek'); break;
    case 'peakHeap': p = lessPhrase(a, b, 'heap'); break;
    default: p = { text: '' };
  }
  return { ...j, text: p.text };
}

export function pairMetrics(r10, r11) {
  const out = {};
  for (const k of Object.keys(METRICS)) out[k] = judge(r10, r11, k);
  return out;
}

/** İki sonucun checksum'ı eşleşiyor mu? true | false | null (bilinmiyor) */
export function checksumMatch(r10, r11) {
  if (r10?.checksumConsistent === false || r11?.checksumConsistent === false) return false;
  const a = r10?.checksum;
  const b = r11?.checksum;
  if (a === undefined || a === null || b === undefined || b === null || a === '' || b === '') return null;
  return String(a) === String(b);
}

/* ------------------------------------------------------------------ */
/* Genel özet                                                           */
/* ------------------------------------------------------------------ */

/**
 * Toplam/ortalama üzerinden verilen hükmü, iş yükü bazındaki hükümlerle sınar (fazla iddiayı önler).
 * - Tek ölçüm (minRep < 2): hüküm korunur ama `single: true` işaretlenir (oynaklık bilinmiyor).
 * - Aynı yönde kesin sonuç veren test sayısı, ters yöndekilerden fazla değilse ya da
 *   "hassasiyet içinde" kalan testlerden azsa: 'noise' (kazanan ilan edilmez).
 */
export function supportedVerdict(total, verdicts, minRep) {
  if (!total || total.verdict === 'na' || total.verdict === 'equal') return total;
  if (minRep < 2) return { ...total, single: true };
  const count = (v) => verdicts.filter((x) => x === v).length;
  const same = count(total.verdict);
  const opposite = count(total.verdict === 'better' ? 'worse' : 'better');
  const noisy = count('noise');
  if (same > opposite && same >= noisy) return { ...total, single: false };
  return { verdict: 'noise', factor: total.factor, rawVerdict: total.verdict, rawText: total.text, text: NOISE_TEXT, single: false };
}

/**
 * results: { [id]: { net10, net11, mode, n, ... } }, order: iş yükü id sırası.
 * Adil ölçüm sonucu varsa özet yalnızca onlardan hesaplanır; gösteri modu sonuçları dışarıda kalır.
 */
export function computeSummary(results, order = []) {
  const ids = Object.keys(results || {});
  const rank = (id) => {
    const i = order.indexOf(id);
    return i < 0 ? 1e9 : i;
  };
  ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  const all = ids.map((id) => ({ id, pair: results[id] })).filter((x) => x.pair?.net10 && x.pair?.net11);
  const fair = all.filter((x) => x.pair.mode !== 'show');
  const useFair = fair.length > 0;
  const used = useFair ? fair : all;
  const excludedShow = useFair ? all.length - fair.length : 0;

  const rows = [];
  let logSum = 0;
  let logN = 0;
  let alloc10 = 0, alloc11 = 0, allocN = 0;
  let gc10 = 0, gc11 = 0, gcN = 0;
  let cpu10 = 0, cpu11 = 0, cpuN = 0;
  let wins = 0, losses = 0, ties = 0, noisy = 0;
  let checksumOk = 0, checksumBad = 0;
  const reps = [];

  for (const { id, pair } of all) {
    const r10 = pair.net10;
    const r11 = pair.net11;
    const included = used.some((u) => u.id === id);
    const row = { id, r10, r11, pair, included, metrics: pairMetrics(r10, r11), checksum: checksumMatch(r10, r11) };
    rows.push(row);
    if (!included) continue;
    reps.push(sampleCount(r10, r11));

    if (isNum(r10.durationMs) && isNum(r11.durationMs) && r10.durationMs > 0 && r11.durationMs > 0) {
      logSum += Math.log(r10.durationMs / r11.durationMs);
      logN++;
      const v = row.metrics.duration.verdict;
      if (v === 'better') wins++;
      else if (v === 'worse') losses++;
      else { ties++; if (v === 'noise') noisy++; }
    }
    if (isNum(r10.allocatedBytes) && isNum(r11.allocatedBytes)) {
      alloc10 += r10.allocatedBytes;
      alloc11 += r11.allocatedBytes;
      allocN++;
    }
    const g10 = gcTotal(r10);
    const g11 = gcTotal(r11);
    if (isNum(g10) && isNum(g11)) {
      gc10 += g10;
      gc11 += g11;
      gcN++;
    }
    if (isNum(r10.cpuTimeMs) && isNum(r11.cpuTimeMs)) {
      cpu10 += r10.cpuTimeMs;
      cpu11 += r11.cpuTimeMs;
      cpuN++;
    }
    if (row.checksum === true) checksumOk++;
    else if (row.checksum === false) checksumBad++;
  }

  const geo = logN ? Math.exp(logSum / logN) : NaN; // >1 => .NET 11 ortalamada daha hızlı
  const minRep = reps.length ? Math.min(...reps) : 0;
  const maxRep = reps.length ? Math.max(...reps) : 0;
  const includedRows = rows.filter((r) => r.included);
  const honest = (total, key) => supportedVerdict(total, includedRows.map((r) => r.metrics[key]?.verdict), minRep);
  return {
    n: rows.length,
    usedN: used.length,
    timedN: logN,
    rows,
    showOnly: !useFair && all.length > 0,
    excludedShow,
    repText: !reps.length ? '' : minRep === maxRep ? `n = ${minRep} tekrar` : `n = ${minRep}–${maxRep} tekrar`,
    minRep,
    geoSpeedup: geo,
    speed: logN ? honest(speedPhrase(geo, 1), 'duration') : { verdict: 'na' },
    alloc10, alloc11, allocN,
    alloc: allocN ? honest(lessPhrase(alloc10, alloc11, 'bellek tahsisi'), 'allocated') : { verdict: 'na' },
    gc10, gc11, gcN,
    gc: gcN ? honest(lessPhrase(gc10, gc11, 'GC toplaması'), 'gc') : { verdict: 'na' },
    cpu10, cpu11, cpuN,
    cpu: cpuN ? honest(lessPhrase(cpu10, cpu11, 'CPU zamanı'), 'cpuTime') : { verdict: 'na' },
    wins, losses, ties, noisy,
    checksumOk, checksumBad,
    band: EQUAL_BAND,
  };
}
