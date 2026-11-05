// Sonuç bölümü: karşılaştırma bandı, genel özet, iş yükü tablosu ve 16:9 özet kartı.

import { h, countTo } from './dom.js';
import * as fmt from './format.js';
import { metricChip, checksumMatch, sampleCount } from './summary.js';

export const SHOW_BADGE_TEXT = 'gösteri modu — kesin ölçüm değil';
export const SINGLE_TEXT = 'tek ölçüm — tekrar edin';
/** /api/info memoryLimitBytes = GC'nin kullanabileceği bellek (konteyner limitinin ~%75'i), konteyner limiti değil */
export const GC_LIMIT_LABEL = 'GC bellek sınırı';
export const GC_LIMIT_HINT = '(konteyner limitinin yaklaşık %75\'i)';

const verdictClass = (v) => `chip chip-${v || 'na'}`;

function chip(c) {
  if (!c || c.verdict === 'na' || !c.text) return null;
  return h('span', { class: verdictClass(c.verdict), title: c.verdict === 'noise' ? 'Runtime farkı, turlar arası oynaklıktan (min–max aralığı) küçük' : c.text }, c.text);
}

export function checksumBadge(match) {
  if (match === true) return h('span', { class: 'badge badge-ok', title: 'İki runtime da aynı checksum değerini üretti' }, '✓ Aynı iş, aynı sonuç');
  if (match === false) return h('span', { class: 'badge badge-warn', title: 'Checksum değerleri farklı (runtime\'lar arasında ya da turlar arasında)' }, '⚠ Sonuçlar farklı');
  return null;
}

export function modeBadge(pair) {
  if (!pair) return null;
  if (pair.mode === 'show') return h('span', { class: 'badge badge-show', title: 'İki runtime aynı anda çalıştı; kaynaklar paylaşıldı' }, `◐ ${SHOW_BADGE_TEXT}`);
  const n = sampleCount(pair.net10, pair.net11);
  if (n < 2) return h('span', { class: 'badge badge-single', title: 'Oynaklık bilinmiyor; 3 veya 5 tekrar önerilir' }, `① ${SINGLE_TEXT}`);
  return h('span', { class: 'badge badge-fair', title: 'Sırayla, dönüşümlü sıra, medyan' }, `⚖ Adil ölçüm · medyan · n = ${n}`);
}

/** Tur şeridi: her turun sırası ve iki süresi */
function roundsStrip(pair) {
  const rounds = Array.isArray(pair.rounds) ? pair.rounds : [];
  if (!rounds.length || pair.mode === 'show') return null;
  return h('div', { class: 'rounds' },
    h('span', { class: 'rounds-label mono' }, 'TURLAR'),
    ...rounds.map((r, i) => {
      const first = r.order?.[0] === 'net11' ? '11→10' : '10→11';
      const sp = fmt.compare(r.net10?.durationMs, r.net11?.durationMs, true);
      return h('span', { class: `round round-${sp.verdict}`, title: `Tur ${i + 1}, sıra ${first}` },
        h('b', {}, `T${i + 1}`),
        h('span', { class: 'round-order' }, first),
        h('span', { class: 'c10' }, fmt.duration(r.net10?.durationMs)),
        h('span', { class: 'round-sep' }, '/'),
        h('span', { class: 'c11' }, fmt.duration(r.net11?.durationMs)));
    }));
}

function spreadText(r, field, f) {
  const s = r?.spread?.[field];
  return s ? `(${f(s[0])}–${f(s[1])})` : '';
}

/** Tek iş yükü için karşılaştırma bandı */
export function renderVerdict(container, pair, workload) {
  if (!pair?.net10 || !pair?.net11) {
    container.replaceChildren(
      h('p', { class: 'verdict-empty' }, 'Bir test başlatın — iki runtime aynı işi yaptıktan sonra farklar burada özetlenir.'),
    );
    container.dataset.state = 'empty';
    return;
  }
  const r10 = pair.net10;
  const r11 = pair.net11;
  const speed = metricChip(r10, r11, 'duration');

  const singleRun = pair.mode !== 'show' && sampleCount(r10, r11) < 2;
  let headline;
  if ((speed.verdict === 'better' || speed.verdict === 'worse') && singleRun) headline = ['Tek ölçümde ', h('b', { class: 'c11' }, '.NET 11'), ` ${speed.text} göründü`];
  else if ((speed.verdict === 'better' || speed.verdict === 'worse') && pair.mode === 'show') headline = ['Gösteride ', h('b', { class: 'c11' }, '.NET 11'), ` ${speed.text} göründü`];
  else if (speed.verdict === 'better' || speed.verdict === 'worse') headline = ['Bu testte ', h('b', { class: 'c11' }, '.NET 11'), ` ${speed.text}`];
  else if (speed.verdict === 'equal') headline = ['Bu testte iki runtime ', h('b', {}, 'aynı hızda'), ' (±%3)'];
  else if (speed.verdict === 'noise') headline = ['Süre farkı ', h('b', {}, 'ölçüm hassasiyeti içinde')];
  else headline = ['Bu test için süre verisi eksik'];

  const meta = [];
  if (workload) meta.push(`${workload.icon ? workload.icon + ' ' : ''}${workload.titleTr}`);
  if (fmt.isNum(pair.scale)) meta.push(`ölçek ${pair.scale}×`);
  meta.push(pair.warmup ? 'ısınmalı' : 'ısınmasız');
  meta.push(pair.mode === 'show' ? 'gösteri (aynı anda)' : sampleCount(r10, r11) > 1 ? `adil ölçüm · ${sampleCount(r10, r11)} tur · medyan` : 'adil ölçüm · tek tur');
  if (pair.at) meta.push(fmt.dateTime(new Date(pair.at)));

  const durF = (v) => fmt.duration(v);
  container.dataset.state = singleRun || pair.mode === 'show' ? 'single' : speed.verdict;
  container.replaceChildren(
    h('div', { class: 'verdict-main' },
      h('div', { class: 'verdict-head' }, ...headline),
      h('div', { class: 'verdict-sub mono' },
        `${fmt.duration(r10.durationMs)} ${spreadText(r10, 'durationMs', durF)} → ${fmt.duration(r11.durationMs)} ${spreadText(r11, 'durationMs', durF)}`)),
    h('div', { class: 'verdict-chips' },
      chip(metricChip(r10, r11, 'allocated')),
      chip(metricChip(r10, r11, 'gc')),
      chip(metricChip(r10, r11, 'cpuTime')),
      checksumBadge(checksumMatch(r10, r11)),
      modeBadge(pair)),
    roundsStrip(pair),
    h('div', { class: 'verdict-meta mono' }, meta.join(' · ')),
  );
}

/* ------------------------------------------------------------------ */

function bars(v10, v11, f, judgement) {
  const max = Math.max(fmt.isNum(v10) ? v10 : 0, fmt.isNum(v11) ? v11 : 0) || 1;
  const row = (rt, v, win) => h('div', { class: `bar bar-${rt}${win ? ' win' : ''}` },
    h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: { width: `${fmt.isNum(v) ? Math.max(v > 0 ? 1.5 : 0, (v / max) * 100) : 0}%` } })),
    h('span', { class: 'bar-val mono' }, f(v)));
  return h('div', { class: 'bars' },
    row('net10', v10, judgement.verdict === 'worse'),
    row('net11', v11, judgement.verdict === 'better'));
}

/** Sonuç tablosu + özet */
export function renderSuite(container, summary, workloadsById, { onOpenCard, onClear, running }) {
  if (!summary.n) {
    container.replaceChildren(
      h('div', { class: 'suite-empty' },
        h('p', {}, 'Henüz sonuç yok.'),
        h('p', { class: 'muted' }, '“Tüm testleri çalıştır” ile bütün iş yüklerini koşturun; genel özet gerçek ölçümlerin medyanlarından burada hesaplanır.')),
    );
    return;
  }

  const hero = renderSummaryHero(summary);

  const head = h('div', { class: 'srow shead', role: 'row' },
    h('div', { role: 'columnheader' }, 'İş yükü'),
    h('div', { role: 'columnheader' }, 'Süre (medyan)'),
    h('div', { role: 'columnheader' }, 'Tahsis edilen'),
    h('div', { role: 'columnheader' }, 'GC (toplam)'),
    h('div', { role: 'columnheader' }, 'CPU zamanı'));

  const rows = summary.rows.map((row) => {
    const w = workloadsById.get(row.id);
    const { r10, r11, pair } = row;
    const n = sampleCount(r10, r11);
    const cs = row.checksum;
    const sub = [
      fmt.isNum(pair.scale) ? `${pair.scale}×` : null,
      pair.mode === 'show' ? 'gösteri' : `n=${n}`,
      cs === true ? '✓ checksum' : cs === false ? '⚠ checksum farklı' : null,
      row.included ? null : 'özete dahil değil',
    ].filter(Boolean).join(' · ');
    const flag = pair.mode === 'show' ? h('span', { class: 'flag flag-show' }, 'gösteri modu') : n < 2 ? h('span', { class: 'flag' }, 'tek ölçüm') : null;
    const cell = (label, v10, v11, f, key) => {
      const j = metricChip(r10, r11, key, { short: true });
      return h('div', { class: 'scell', role: 'cell', 'data-label': label }, bars(v10, v11, f, j), chip(j));
    };
    return h('div', { class: `srow srow-${row.metrics.duration.verdict}${row.included ? '' : ' excluded'}`, role: 'row' },
      h('div', { class: 'scell sname', role: 'cell' },
        h('span', { class: 'sicon', 'aria-hidden': 'true' }, w?.icon || '•'),
        h('span', { class: 'stitle' },
          h('b', {}, w?.titleTr || row.id),
          h('small', { class: 'mono' }, sub),
          flag)),
      cell('Süre (medyan)', r10.durationMs, r11.durationMs, fmt.duration, 'duration'),
      cell('Tahsis edilen', r10.allocatedBytes, r11.allocatedBytes, fmt.bytes, 'allocated'),
      cell('GC (toplam)', fmt.gcTotal(r10), fmt.gcTotal(r11), fmt.int, 'gc'),
      cell('CPU zamanı', r10.cpuTimeMs, r11.cpuTimeMs, fmt.duration, 'cpuTime'),
    );
  });

  const legend = h('div', { class: 'legend' },
    h('span', { class: 'lg lg-net10' }, h('i'), '.NET 10'),
    h('span', { class: 'lg lg-net11' }, h('i'), '.NET 11'),
    h('span', { class: 'lg-note muted' }, 'Çubuklar her satırda kendi içinde ölçeklenir · kısa çubuk = daha az/daha iyi'));

  const actions = h('div', { class: 'suite-actions' },
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: onOpenCard }, '▣ Özet kartı'),
    h('button', { class: 'btn btn-ghost btn-danger', type: 'button', onclick: onClear, disabled: running ? true : null }, 'Sonuçları temizle'));

  container.replaceChildren(
    hero,
    h('div', { class: 'suite-toolbar' }, legend, actions),
    h('div', { class: 'stable', role: 'table', 'aria-label': 'İş yükü sonuçları' }, head, ...rows),
  );
}

function kpi(label, valueNode, sub, verdict) {
  return h('div', { class: `kpi kpi-${verdict || 'na'}` },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value' }, valueNode),
    sub ? h('div', { class: 'kpi-sub mono' }, sub) : null);
}

function speedValue(summary) {
  const g = summary.geoSpeedup;
  const node = h('span', { class: 'num' });
  if (!fmt.isNum(g)) {
    node.textContent = '—';
    return { node, headline: 'Süre verisi yok' };
  }
  const v = summary.speed.verdict;
  const single = !!summary.speed.single;
  const lead = single ? 'Tek ölçümde ortalama' : 'Ortalama';
  const tail = single ? ' göründü' : '';
  let headline;
  if (v === 'better') headline = g >= 1.5 ? `${lead} ${fmt.times(g)} daha hızlı${tail}` : `${lead} ${fmt.pctDiff((g - 1) * 100)} daha hızlı${tail}`;
  else if (v === 'worse') headline = 1 / g >= 1.5 ? `${lead} ${fmt.times(1 / g)} daha yavaş${tail}` : `${lead} ${fmt.pctDiff((1 / g - 1) * 100)} daha yavaş${tail}`;
  else if (v === 'noise') headline = 'Farkların çoğu ölçüm hassasiyeti içinde';
  else headline = 'Ortalamada benzer hız';
  countTo(node, g, (x) => `${fmt.num(x, 2, 2)}×`, { duration: 900 });
  return { node, headline };
}

function winsLine(summary, withName = true) {
  const who = withName ? ' .NET 11' : '';
  if (summary.timedN === 1) return summary.wins ? `Tek testte${who} önde` : `Tek testte${who} önde değil`;
  if (!summary.wins) return `${summary.timedN} testin hiçbirinde${who} önde değil`;
  return `${summary.timedN} testin ${fmt.locativePossessive(summary.wins)}${who} önde`;
}

/** KPI hükmü: tek ölçümde renk verilmez (oynaklık bilinmiyor) */
const kpiVerdict = (c) => (c?.single ? 'single' : c?.verdict);

function gcSub(summary) {
  const c = summary.gc;
  if (c.verdict === 'noise') return c.text;
  if (c.verdict === 'equal') return '≈ aynı';
  if (c.verdict === 'better' || c.verdict === 'worse') return c.text;
  return '';
}

function speedCaveat(summary) {
  if (summary.speed.verdict === 'noise') return ' Oran 1\'den farklı olsa da testlerin çoğunda fark turlar arası oynaklıktan küçük — kesin bir hız farkı söylenemez.';
  if (summary.speed.single) return ' Tek ölçüm: oynaklık bilinmiyor; güvenilir sonuç için 3 veya 5 tekrarla çalıştırın.';
  return '';
}

function summaryNotes(summary) {
  const notes = [];
  if (summary.repText) notes.push(summary.repText);
  if (summary.minRep < 2 && !summary.showOnly) notes.push(summary.repText === 'n = 1 tekrar' ? 'tek ölçüm — tekrar edin' : 'bazı testler tek ölçüm');
  if (summary.excludedShow) notes.push(`gösteri modundaki ${summary.excludedShow} test özete dahil değil`);
  return notes;
}

export function renderSummaryHero(summary) {
  const { node: speedNode, headline } = speedValue(summary);
  const extra = [];
  if (summary.ties) extra.push(`${summary.ties} berabere${summary.noisy ? ` (${summary.noisy} tanesi ölçüm hassasiyeti içinde)` : ''}`);
  if (summary.losses) extra.push(`${summary.losses} testte .NET 10 önde`);

  const allocText = summary.alloc.verdict === 'na' ? '—' : summary.alloc.text;
  const notes = summaryNotes(summary);
  const single = summary.minRep < 2;
  const winsVerdict = single ? 'single' : summary.wins > summary.losses ? 'better' : summary.wins < summary.losses ? 'worse' : 'equal';
  const winsSub = extra.join(' · ') || 'süre bazında; ±%3 ve ölçüm oynaklığı içi berabere';

  return h('div', { class: `summary-hero sv-${summary.speed.single ? 'single' : summary.speed.verdict}${summary.showOnly ? ' show-only' : ''}` },
    h('div', { class: 'sh-main' },
      h('div', { class: 'sh-kicker mono' }, 'GENEL ÖZET', notes.length ? h('span', { class: 'sh-n' }, notes.join(' · ')) : null),
      summary.showOnly ? h('div', { class: 'badge badge-show' }, `◐ ${SHOW_BADGE_TEXT} — kesin sayılar için “Adil ölçüm” ile çalıştırın`) : null,
      h('div', { class: 'sh-big' }, speedNode),
      h('div', { class: 'sh-headline' }, headline),
      h('div', { class: 'sh-sub muted' }, `Medyan süre oranlarının geometrik ortalaması (.NET 10 ÷ .NET 11), ${summary.timedN} iş yükü.${speedCaveat(summary)}`)),
    h('div', { class: 'sh-kpis' },
      kpi('Bellek tahsisi', h('span', {}, allocText), `${fmt.bytes(summary.alloc10)} → ${fmt.bytes(summary.alloc11)}`, kpiVerdict(summary.alloc)),
      kpi('GC toplamı', h('span', {}, `${fmt.int(summary.gc10)} → ${fmt.int(summary.gc11)}`), gcSub(summary), kpiVerdict(summary.gc)),
      kpi('Kazanılan testler', h('span', {}, winsLine(summary)), single ? `${winsSub} · tek ölçüm` : winsSub, winsVerdict),
      kpi('CPU zamanı', h('span', {}, summary.cpu.verdict === 'na' ? '—' : summary.cpu.text), `${fmt.duration(summary.cpu10)} → ${fmt.duration(summary.cpu11)}`, kpiVerdict(summary.cpu)),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 16:9 Özet kartı                                                      */
/* ------------------------------------------------------------------ */

function infoLine(info) {
  if (!info) return '—';
  const parts = [];
  if (fmt.isNum(info.processorCount)) parts.push(`${info.processorCount} vCPU`);
  if (fmt.isNum(info.memoryLimitBytes) && info.memoryLimitBytes > 0) parts.push(`${fmt.bytes(info.memoryLimitBytes)} ${GC_LIMIT_LABEL} ${GC_LIMIT_HINT}`);
  if (info.os || info.arch) parts.push([info.os, info.arch].filter(Boolean).join(' '));
  if (info.gc) parts.push(info.gc.server ? 'Server GC' : 'Workstation GC');
  return parts.join(' · ');
}

/** İki konteynerin bildirdiği CPU/bellek limitleri aynı mı? (yalnızca /api/info verisinden) */
export function limitsMatch(i10, i11) {
  if (!i10 || !i11) return null;
  return i10.processorCount === i11.processorCount && i10.memoryLimitBytes === i11.memoryLimitBytes;
}

export function limitsText(i10, i11) {
  const m = limitsMatch(i10, i11);
  if (m === true) return 'iki konteynerde aynı CPU sayısı ve GC bellek sınırı';
  if (m === false) return 'DİKKAT: kaynak sınırları eşit değil';
  return 'limit bilgisi eksik';
}

export { infoLine };

export function renderSlide(container, summary, infos, workloadsById) {
  const i10 = infos.net10;
  const i11 = infos.net11;
  if (!summary.n) {
    container.replaceChildren(h('div', { class: 'slide-empty' },
      h('p', {}, 'Özet kartı için önce en az bir test çalıştırın.'),
      h('p', { class: 'muted' }, 'Kart yalnızca gerçek ölçüm sonuçlarından oluşturulur.')));
    return;
  }
  const { node: speedNode, headline } = speedValue(summary);
  const included = summary.rows.filter((r) => r.included);

  const maxLog = Math.max(0.05, ...included.map((r) => {
    const f = r.r10.durationMs / r.r11.durationMs;
    return fmt.isNum(f) && f > 0 ? Math.abs(Math.log(f)) : 0;
  }));
  const mini = included.map((r) => {
    const f = r.r10.durationMs / r.r11.durationMs;
    const lg = fmt.isNum(f) && f > 0 ? Math.log(f) : 0;
    const width = (Math.abs(lg) / maxLog) * 50;
    const v = r.metrics.duration.verdict;
    const w = workloadsById.get(r.id);
    return h('div', { class: `mrow mrow-${v}`, title: v === 'noise' ? 'fark ölçüm hassasiyeti içinde' : '' },
      h('span', { class: 'mname' }, `${w?.icon ? w.icon + ' ' : ''}${w?.titleTr || r.id}`),
      h('span', { class: 'mtrack' },
        h('span', { class: 'mzero' }),
        h('span', { class: 'mfill', style: lg >= 0 ? { left: '50%', width: `${width}%` } : { left: `${50 - width}%`, width: `${width}%` } })),
      h('span', { class: 'mval mono' }, fmt.isNum(f) ? `${fmt.num(f, 2, 2)}×${v === 'noise' ? '≈' : ''}` : '—'));
  });

  const pre = /rc|preview|alpha|beta/i.test(i11?.runtimeLabel || '');
  const date = summary.rows.reduce((m, r) => Math.max(m, r.pair.at || 0), 0);
  const method = summary.showOnly ? 'GÖSTERİ MODU (AYNI ANDA) · KESİN ÖLÇÜM DEĞİL'
    : `ADİL ÖLÇÜM · SIRAYLA, DÖNÜŞÜMLÜ · ${summary.minRep < 2 ? 'TEK ÖLÇÜM — TEKRAR EDİN' : `MEDYAN · ${summary.repText.toLocaleUpperCase('tr-TR')}`}`;
  const bigState = summary.speed.single ? 'single' : summary.speed.verdict;

  container.replaceChildren(
    h('div', { class: `slide${summary.showOnly ? ' slide-show' : ''}` },
      h('div', { class: 'slide-bg', 'aria-hidden': 'true' }),
      h('header', { class: 'slide-top' },
        h('div', { class: 'slide-brand' },
          h('span', { class: 'wm wm-10' }, '·NET 10'),
          h('span', { class: 'slide-vs' }, 'vs'),
          h('span', { class: 'wm wm-11' }, '·NET 11')),
        h('div', { class: 'slide-date mono' }, date ? fmt.dateTime(new Date(date)) : '')),
      h('div', { class: 'slide-body' },
        h('div', { class: 'slide-hero' },
          h('div', { class: 'slide-kicker mono' }, method),
          h('div', { class: `slide-big sb-${bigState}` }, speedNode),
          h('div', { class: 'slide-headline' }, headline),
          h('div', { class: 'slide-kpis' },
            h('div', { class: `skpi skpi-${kpiVerdict(summary.alloc)}` }, h('b', {}, summary.alloc.verdict === 'na' ? '—' : summary.alloc.text), h('span', {}, `${fmt.bytes(summary.alloc10)} → ${fmt.bytes(summary.alloc11)}`)),
            h('div', { class: `skpi skpi-${kpiVerdict(summary.gc)}` }, h('b', {}, `GC ${fmt.int(summary.gc10)} → ${fmt.int(summary.gc11)}`), h('span', {}, `toplam çöp toplama sayısı${summary.gc.verdict === 'noise' ? ' · hassasiyet içinde' : ''}`)),
            h('div', { class: 'skpi skpi-neutral' }, h('b', {}, winsLine(summary, false)), h('span', {}, `.NET 11, süre bazında${summary.ties ? ` · ${summary.ties} berabere` : ''}${summary.losses ? ` · ${summary.losses} geride` : ''}`)))),
        h('div', { class: 'slide-mini' },
          h('div', { class: 'mini-head mono' }, h('span', {}, '← .NET 10 önde'), h('span', {}, 'medyan hız oranı'), h('span', {}, '.NET 11 önde →')),
          ...mini)),
      h('footer', { class: 'slide-foot mono' },
        h('div', {}, h('span', { class: 'c10' }, i10?.runtimeLabel || '.NET 10'), '  ·  ', h('span', { class: 'c11' }, i11?.runtimeLabel || '.NET 11'), pre ? '  (önizleme sürümü)' : ''),
        h('div', {}, `${infoLine(i11 || i10)} · ${limitsText(i10, i11)} · Sonuçlar bu makinede, Docker içinde ölçülmüştür.`)),
    ),
  );
}
