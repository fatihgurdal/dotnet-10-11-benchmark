// Türkçe sayı / birim / oran biçimlendirme yardımcıları.
// Tüm biçimlendirme Intl (tr-TR) üzerinden yapılır: 1.234,5

const LOCALE = 'tr-TR';
const nfCache = new Map();

function nf(min, max, extra = {}) {
  const key = `${min}|${max}|${JSON.stringify(extra)}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: min, maximumFractionDigits: max, ...extra });
    nfCache.set(key, f);
  }
  return f;
}

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Genel sayı: 1.234,5 */
export function num(v, maxFrac = 0, minFrac = 0) {
  if (!isNum(v)) return '—';
  return nf(minFrac, maxFrac).format(v);
}

/** Tam sayı (binlik ayraçlı) */
export function int(v) {
  if (!isNum(v)) return '—';
  return nf(0, 0).format(Math.round(v));
}

/** Kısa sayı: 1,2 Mn / 236,9 bin / 3,4 Mr ("B" bayt ile karışmasın diye "bin" yazılır) */
export function compact(v) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  if (a < 10000) return nf(0, a < 100 ? 1 : 0).format(v);
  if (a < 1e6) return `${nf(1, 1).format(v / 1e3)} bin`;
  if (a < 1e9) return `${nf(2, 2).format(v / 1e6)} Mn`;
  return `${nf(2, 2).format(v / 1e9)} Mr`;
}

/**
 * CPU yüzdesinin çekirdek eşdeğeri: "≈ 1,0 çekirdek".
 * pct, konteynerdeki TÜM çekirdekler üzerindendir (2 çekirdekte tek iş parçacığı ≈ %50).
 */
export function cores(pctValue, processorCount) {
  if (!isNum(pctValue) || !isNum(processorCount) || processorCount <= 0) return '';
  return `≈ ${nf(1, 1).format((pctValue / 100) * processorCount)} çekirdek`;
}

/**
 * Fark yüzdesi: tam sayıya yuvarlanınca ±%3 "aynı" bandına düşecek küçük farklar bir ondalıkla yazılır
 * ("%3 daha yavaş" yerine "%3,3 daha yavaş"), böylece "±%3 içi aynı" kuralıyla çelişkili görünmez.
 */
export function pctDiff(v) {
  if (!isNum(v)) return '—';
  return Math.round(Math.abs(v)) <= EQUAL_BAND * 100 ? pct(v, 1) : pct(v);
}

/** Yüzde: %38 (Türkçede işaret başta) */
export function pct(v, maxFrac = 0) {
  if (!isNum(v)) return '—';
  return '%' + nf(0, maxFrac).format(v);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Bayt -> "12,3 MB" (1024 tabanlı) */
export function bytes(v) {
  if (!isNum(v) || v < 0) return '—';
  let i = 0;
  let x = v;
  while (x >= 1024 && i < BYTE_UNITS.length - 1) { x /= 1024; i++; }
  const frac = i === 0 ? 0 : x < 10 ? 2 : x < 100 ? 1 : 0;
  return `${nf(frac, frac).format(x)} ${BYTE_UNITS[i]}`;
}

/** Bayt değerini [sayı, birim] olarak ayırır (büyük okuma göstergeleri için) */
export function bytesParts(v) {
  const s = bytes(v);
  const idx = s.lastIndexOf(' ');
  return idx < 0 ? [s, ''] : [s.slice(0, idx), s.slice(idx + 1)];
}

/**
 * Büyük göstergeler için: hedef değerin birimini sabitler, [sayıBiçimlendirici, birim] döner.
 * Böylece sayarak animasyon sırasında birim değişmez (ör. 0 → 4,22 sn boyunca hep "sn").
 */
export function bytesScaled(target) {
  if (!isNum(target) || target < 0) return [() => '—', ''];
  let i = 0;
  let x = target;
  while (x >= 1024 && i < BYTE_UNITS.length - 1) { x /= 1024; i++; }
  const div = 1024 ** i;
  const frac = i === 0 ? 0 : x < 10 ? 2 : x < 100 ? 1 : 0;
  return [(v) => (isNum(v) ? nf(frac, frac).format(v / div) : '—'), BYTE_UNITS[i]];
}

/** compact() ile aynı ölçek, birimsiz (aralık metni için) */
export function compactScaled(target) {
  const a = Math.abs(target);
  if (!isNum(target) || a < 10000) return (v) => (isNum(v) ? nf(0, a < 100 ? 1 : 0).format(v) : '—');
  if (a < 1e6) return (v) => (isNum(v) ? nf(1, 1).format(v / 1e3) : '—');
  if (a < 1e9) return (v) => (isNum(v) ? nf(2, 2).format(v / 1e6) : '—');
  return (v) => (isNum(v) ? nf(2, 2).format(v / 1e9) : '—');
}

export function durationScaled(ms) {
  if (!isNum(ms) || ms < 0) return [() => '—', ''];
  if (ms < 10) return [(v) => (isNum(v) ? nf(2, 2).format(v) : '—'), 'ms'];
  if (ms < 1000) return [(v) => (isNum(v) ? nf(0, 0).format(v) : '—'), 'ms'];
  return [(v) => (isNum(v) ? nf(2, 2).format(v / 1000) : '—'), 'sn'];
}

/** Milisaniye -> "842 ms" / "12,34 sn" */
export function duration(ms) {
  if (!isNum(ms) || ms < 0) return '—';
  if (ms < 10) return `${nf(2, 2).format(ms)} ms`;
  if (ms < 1000) return `${nf(0, 0).format(ms)} ms`;
  const s = ms / 1000;
  return `${nf(2, 2).format(s)} sn`;
}

export function durationParts(ms) {
  const s = duration(ms);
  const idx = s.lastIndexOf(' ');
  return idx < 0 ? [s, ''] : [s.slice(0, idx), s.slice(idx + 1)];
}

/** GC sayaçları: "g0:3.440 g1:0 g2:0" */
export function gcTriple(g0, g1, g2) {
  if (![g0, g1, g2].some(isNum)) return '—';
  return `g0:${int(g0 ?? 0)} g1:${int(g1 ?? 0)} g2:${int(g2 ?? 0)}`;
}

/** Oran: "2,4×" */
export function times(ratio) {
  if (!isNum(ratio)) return '—';
  const frac = ratio >= 100 ? 0 : ratio >= 10 ? 0 : 1;
  return `${nf(frac, frac).format(ratio)}×`;
}

export function dateTime(d) {
  try {
    return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long', timeStyle: 'short' }).format(d);
  } catch {
    return String(d);
  }
}

/**
 * Bir sayıya Türkçe "-(s)I(n)dA" (bulunma + iyelik) ekini getirir: 7'sinde, 9'unda, 6'sında.
 * "9 testin 7'sinde" gibi cümleler için.
 */
export function locativePossessive(n) {
  const v = Math.abs(Math.trunc(n));
  const ones = {
    1: "'inde", 2: "'sinde", 3: "'ünde", 4: "'ünde", 5: "'inde",
    6: "'sında", 7: "'sinde", 8: "'inde", 9: "'unda",
  };
  const tens = {
    1: "'unda", 2: "'sinde", 3: "'unda", 4: "'ında", 5: "'sinde",
    6: "'ında", 7: "'inde", 8: "'inde", 9: "'ında",
  };
  let suffix;
  if (v === 0) suffix = "'ında";
  else if (v % 10 !== 0) suffix = ones[v % 10];
  else if (v % 100 !== 0) suffix = tens[(v / 10) % 10];
  else if (v % 1000 !== 0) suffix = "'ünde"; // yüz
  else suffix = "'inde"; // bin
  return `${int(n)}${suffix}`;
}

/* ------------------------------------------------------------------ */
/* Karşılaştırma ifadeleri                                             */
/* ------------------------------------------------------------------ */

export const EQUAL_BAND = 0.03; // ±%3 içinde "aynı" kabul edilir

/**
 * İki değeri karşılaştırır. lowerIsBetter=true ise küçük olan daha iyidir.
 * Dönüş: { verdict: 'better'|'worse'|'equal'|'na', factor } — factor >= 1, .NET 11'in ne kadar iyi/kötü olduğu.
 */
export function compare(v10, v11, lowerIsBetter = true) {
  if (!isNum(v10) || !isNum(v11) || v10 < 0 || v11 < 0) return { verdict: 'na', factor: NaN };
  if (v10 === 0 && v11 === 0) return { verdict: 'equal', factor: 1 };
  // "iyilik" oranı: >1 => .NET 11 daha iyi
  let good;
  if (lowerIsBetter) good = v11 === 0 ? Infinity : v10 / v11;
  else good = v10 === 0 ? Infinity : v11 / v10;
  if (Math.abs(good - 1) <= EQUAL_BAND) return { verdict: 'equal', factor: good };
  return good > 1 ? { verdict: 'better', factor: good } : { verdict: 'worse', factor: 1 / good };
}

/**
 * Hız ifadesi (süre için): factor = t10/t11.
 * >=1,5 kat: "2,4× daha hızlı"; aksi halde hız artışı yüzde olarak.
 */
export function speedPhrase(t10, t11) {
  const c = compare(t10, t11, true);
  if (c.verdict === 'na') return c;
  if (c.verdict === 'equal') return { ...c, text: '≈ aynı süre' };
  const word = c.verdict === 'better' ? 'daha hızlı' : 'daha yavaş';
  const text = !isFinite(c.factor) ? `çok ${word}`
    : c.factor >= 1.5 ? `${times(c.factor)} ${word}` : `${pctDiff((c.factor - 1) * 100)} ${word}`;
  return { ...c, text };
}

/** Miktar ifadesi (az olan iyi): "12× daha az tahsis", "%30 daha az bellek" */
export function lessPhrase(v10, v11, noun) {
  const c = compare(v10, v11, true);
  if (c.verdict === 'na') return c;
  if (c.verdict === 'equal') return { ...c, text: `≈ aynı ${noun}` };
  if (c.verdict === 'better') {
    if (v11 === 0) return { ...c, text: `sıfır ${noun}` };
    const text = c.factor >= 1.5 ? `${times(c.factor)} daha az ${noun}` : `${pctDiff((1 - v11 / v10) * 100)} daha az ${noun}`;
    return { ...c, text };
  }
  if (v10 === 0) return { ...c, text: `daha fazla ${noun}` };
  const text = c.factor >= 1.5 ? `${times(c.factor)} daha fazla ${noun}` : `${pctDiff((v11 / v10 - 1) * 100)} daha fazla ${noun}`;
  return { ...c, text };
}

/** Miktar ifadesi (çok olan iyi): "%38 daha fazla işlem/sn" */
export function morePhrase(v10, v11, noun) {
  const c = compare(v10, v11, false);
  if (c.verdict === 'na') return c;
  if (c.verdict === 'equal') return { ...c, text: `≈ aynı ${noun}` };
  const word = c.verdict === 'better' ? 'daha fazla' : 'daha az';
  if (!isFinite(c.factor)) return { ...c, text: `${word} ${noun}` };
  const text = c.factor >= 1.5 ? `${times(c.factor)} ${word} ${noun}`
    : c.verdict === 'better' ? `${pctDiff((c.factor - 1) * 100)} ${word} ${noun}`
      : `${pctDiff((1 - v11 / v10) * 100)} ${word} ${noun}`;
  return { ...c, text };
}

/** "GC 3.440 → 0" */
export function arrowPhrase(prefix, v10, v11, fmt = int) {
  const c = compare(v10, v11, true);
  return { ...c, text: `${prefix} ${fmt(v10)} → ${fmt(v11)}` };
}

export function gcTotal(r) {
  if (!r) return NaN;
  const vals = [r.gc0, r.gc1, r.gc2].filter(isNum);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : NaN;
}
