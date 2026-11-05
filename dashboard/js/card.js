// Runtime kartı: başlık, 100 karo ilerleme ızgarası, DIMM · HEAP bellek çubuğu, istatistikler.

import { h, setText, toggle, countTo, setLive } from './dom.js';
import * as fmt from './format.js';

const TILE_COLS = 20;
const TILE_ROWS = 5;
const TILES = TILE_COLS * TILE_ROWS;
const DIMM_CELLS = 20;

const PHASE_TEXT = {
  idle: 'Hazır',
  queued: 'Sırada bekliyor',
  connecting: 'Bağlanıyor…',
  warmup: 'Isınma turu…',
  measure: 'Ölçülüyor',
  done: 'Tamamlandı',
  saved: 'Kayıtlı sonuç',
  error: 'Hata',
  aborted: 'Durduruldu',
  offline: 'Bağlantı yok',
};

// İstatistik tanımları: anahtar, etiket, biçimlendirici
// field: sonuçtaki alan (min–max aralığı için), sfmt: medyana göre birimsiz sayı biçimlendirici
const oneDec = () => (v) => fmt.num(v, 1, 1);
const STATS = [
  { key: 'opsPerSec', label: 'İŞLEM/SN', fmt: fmt.compact, field: 'opsPerSec', sfmt: fmt.compactScaled },
  { key: 'cpuAvg', label: 'CPU ORT.', fmt: (v) => fmt.pct(v, 1), field: 'avgCpuPercent', sfmt: oneDec },
  { key: 'cpuTime', label: 'CPU ZAMANI', fmt: fmt.duration, field: 'cpuTimeMs', sfmt: (m) => fmt.durationScaled(m)[0] },
  { key: 'peakWs', label: 'ZİRVE BELLEK', fmt: fmt.bytes, field: 'peakWorkingSetBytes', sfmt: (m) => fmt.bytesScaled(m)[0] },
  { key: 'peakHeap', label: 'HEAP ZİRVESİ', fmt: fmt.bytes, field: 'peakGcHeapBytes', sfmt: (m) => fmt.bytesScaled(m)[0] },
  { key: 'gcPause', label: 'GC DURAKLAMA', fmt: (v) => (fmt.isNum(v) ? `${fmt.num(v, v < 10 ? 2 : 1)} ms` : '—'), field: 'gcPauseMs', sfmt: oneDec },
  { key: 'gc', label: 'GC', fmt: null, field: 'gcTotal', sfmt: () => fmt.int },
];

// Büyük göstergeler: SÜRE ve TAHSİS EDİLEN RAM
const HEROES = [
  { key: 'duration', label: 'SÜRE', scaled: fmt.durationScaled, field: 'durationMs' },
  { key: 'allocated', label: 'TAHSİS EDİLEN RAM', scaled: fmt.bytesScaled, field: 'allocatedBytes' },
];

const crownSvg = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'crown-ic');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5L3 8z');
  s.appendChild(p);
  return s;
};

export function createRuntimeCard(rt, { major }) {
  const tiles = [];
  const tileWrap = h('div', { class: 'tiles', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': `.NET ${major} ilerleme` });
  for (let i = 0; i < TILES; i++) {
    const r = Math.floor(i / TILE_COLS);
    const c = i % TILE_COLS;
    const t = h('i', { style: { '--d': String(r + c) } });
    tiles.push(t);
    tileWrap.appendChild(t);
  }

  const cells = [];
  const cellWrap = h('div', { class: 'dimm-cells' });
  for (let i = 0; i < DIMM_CELLS; i++) {
    const c = h('i');
    cells.push(c);
    cellWrap.appendChild(c);
  }
  const pins = h('div', { class: 'dimm-pins' }, h('span', { class: 'pins-l' }), h('span', { class: 'notch' }), h('span', { class: 'pins-r' }));

  const labelEl = h('div', { class: 'rt-label mono', title: 'runtimeLabel' }, '—');
  const winBadge = h('span', { class: 'win-badge', 'aria-hidden': 'true' }, crownSvg(), h('span', { text: 'Daha hızlı' }));
  const phaseEl = h('span', { class: 'phase' }, h('span', { class: 'phase-dot' }), h('span', { class: 'phase-text', text: 'Hazır' }));
  const pctEl = h('span', { class: 'phase-pct mono' }, '');
  const noteEl = h('div', { class: 'rt-note' }, '');

  const heroEls = {};
  const heroWrap = h('div', { class: 'heroes' });
  for (const d of HEROES) {
    const v = h('span', { class: 'v' }, '—');
    const u = h('span', { class: 'u' }, '');
    const chip = h('span', { class: 'chip', hidden: true });
    const crown = h('span', { class: 'crown', title: 'Bu metrikte önde' }, crownSvg());
    const sp = h('span', { class: 'spread mono' });
    const flag = h('span', { class: 'chip-flag', hidden: true }, 'tek ölçüm — tekrar edin');
    heroWrap.appendChild(h('div', { class: `readout readout-${d.key}` },
      h('div', { class: 'lbl' }, d.label, sp),
      h('div', { class: 'readout-row' }, h('span', { class: 'big mono' }, v, u), crown),
      h('div', { class: 'chip-slot' }, chip, flag)));
    heroEls[d.key] = { v, u, chip, crown, sp, flag, def: d };
  }

  const statEls = {};
  const statGrid = h('dl', { class: 'stats' });
  for (const s of STATS) {
    const v = h('span', { class: 'v' }, '—');
    const crown = h('span', { class: 'crown', title: 'Bu metrikte önde' }, crownSvg());
    const chip = h('span', { class: 'chip', hidden: true });
    const sp = h('span', { class: 'spread mono' });
    // CPU ORT.: yüzde konteynerdeki tüm çekirdekler üzerindendir; hemen altında çekirdek eşdeğeri gösterilir
    // (CPU ORT. için karşılaştırma çipi yoktur, bu yüzden çip satırı kullanılır: düzen kaymaz)
    const cores = s.key === 'cpuAvg' ? h('span', { class: 'cores mono', title: 'Çekirdek eşdeğeri = CPU ort. ÷ 100 × konteynerdeki çekirdek sayısı' }) : null;
    const box = h('div', { class: `stat stat-${s.key}` },
      h('dt', {}, s.label, sp),
      h('dd', {}, v, crown),
      h('div', { class: 'chip-slot' }, chip, cores));
    statEls[s.key] = { box, v, crown, chip, sp, cores, def: s };
    statGrid.appendChild(box);
  }

  const root = h('article', { class: `rt-card rt-${rt}`, 'aria-label': `.NET ${major}` },
    h('div', { class: 'rt-glow', 'aria-hidden': 'true' }),
    h('header', { class: 'rt-head' },
      h('div', { class: 'rt-title' },
        h('span', { class: 'rt-dot', 'aria-hidden': 'true' }, '·'),
        h('span', { class: 'rt-net' }, 'NET'),
        h('span', { class: 'rt-major' }, ` ${major}`),
        winBadge),
      labelEl),
    h('div', { class: 'rt-status' }, phaseEl, pctEl),
    tileWrap,
    h('div', { class: 'dimm', 'aria-hidden': 'true' },
      h('div', { class: 'dimm-tag mono' }, 'DIMM · HEAP'),
      h('div', { class: 'dimm-board' }, h('span', { class: 'dimm-chip-l' }), cellWrap),
      pins),
    heroWrap,
    h('hr', { class: 'divider' }),
    statGrid,
    noteEl,
  );

  let litTiles = -1;
  let litCells = -1;
  let completeShown = false;

  function setChip(chipEl, c) {
    if (!c || !c.text || c.verdict === 'na') {
      chipEl.hidden = true;
      return;
    }
    chipEl.hidden = false;
    chipEl.className = `chip chip-${c.verdict}`;
    setText(chipEl, c.text);
  }

  /**
   * view: {
   *  label, phase, progress, error, note,
   *  allocated, allocCells (0..20), final (bool),
   *  stats: { duration, gc:[g0,g1,g2], cpuAvg, gcPause, opsPerSec, cpuTime, peakWs, peakHeap },
   *  chips: { [key]: {verdict,text} }, crowns: Set<key>, winner: bool
   * }
   */
  function update(view) {
    setText(labelEl, view.label || '—');
    labelEl.title = view.label || '';
    const phase = view.phase || 'idle';
    root.dataset.phase = phase;
    setText(phaseEl.lastChild, view.phaseText || PHASE_TEXT[phase] || phase);
    setText(pctEl, phase === 'measure' ? fmt.pct(Math.floor((view.progress || 0) * 100)) : '');

    // Karolar
    const lit = phase === 'done' || phase === 'saved' ? TILES : Math.max(0, Math.min(TILES, Math.floor((view.progress || 0) * TILES)));
    if (lit !== litTiles) {
      for (let i = 0; i < TILES; i++) toggle(tiles[i], 'on', i < lit);
      litTiles = lit;
      tileWrap.setAttribute('aria-valuenow', String(lit));
    }
    const complete = phase === 'done';
    if (complete && !completeShown) {
      tileWrap.classList.remove('ripple');
      void tileWrap.offsetWidth; // animasyonu yeniden başlat
      tileWrap.classList.add('ripple');
    }
    if (!complete) tileWrap.classList.remove('ripple');
    completeShown = complete;

    // DIMM
    const cellsOn = Math.max(0, Math.min(DIMM_CELLS, view.allocCells || 0));
    if (cellsOn !== litCells) {
      for (let i = 0; i < DIMM_CELLS; i++) toggle(cells[i], 'on', i < cellsOn);
      litCells = cellsOn;
    }

    const animate = !!view.final && view.animate !== false;
    const write = (node, value, f) => (animate ? countTo(node, value, f) : setLive(node, value, f));

    // Büyük göstergeler
    for (const d of HEROES) {
      const e = heroEls[d.key];
      const val = d.key === 'allocated' ? view.allocated : view.stats?.[d.key];
      const [f, unit] = d.scaled(val);
      write(e.v, val, f);
      setText(e.u, unit);
      toggle(e.v, 'dim', !fmt.isNum(val));
      setChip(e.chip, view.chips?.[d.key]);
      toggle(e.crown, 'show', view.crowns?.has(d.key));
      setText(e.sp, spreadText(view.spread, d.field, (m) => d.scaled(m)[0], val));
      e.flag.hidden = !(view.single && d.key === 'duration' && view.chips?.duration);
    }

    for (const s of STATS) {
      const e = statEls[s.key];
      const val = view.stats?.[s.key];
      if (s.key === 'gc') {
        const g = Array.isArray(val) ? val : null;
        setText(e.v, g ? fmt.gcTriple(g[0], g[1], g[2]) : '—');
      } else if (val === 'pending') {
        setLive(e.v, NaN, () => '…');
      } else {
        write(e.v, val, s.fmt);
      }
      toggle(e.v, 'dim', s.key === 'gc' ? !Array.isArray(val) || !val.some(fmt.isNum) : !fmt.isNum(val));
      if (e.cores) setText(e.cores, fmt.cores(val, view.cpuCount));
      setChip(e.chip, view.chips?.[s.key]);
      toggle(e.crown, 'show', view.crowns?.has(s.key));
      const median = s.key === 'gc' ? (Array.isArray(val) ? val.reduce((a, b) => a + (fmt.isNum(b) ? b : 0), 0) : undefined) : val;
      setText(e.sp, spreadText(view.spread, s.field, s.sfmt, median));
    }

    toggle(root, 'is-winner', !!view.winner);
    toggle(root, 'is-active', phase === 'measure' || phase === 'warmup' || phase === 'connecting');
    toggle(root, 'is-error', phase === 'error' || phase === 'offline');
    setText(noteEl, view.note || '');
    toggle(noteEl, 'is-error', phase === 'error');
    noteEl.dataset.kind = view.noteKind || '';
  }

  return { root, update };
}

/** "min–max" aralık metni (yalnızca birden çok tur varsa) */
function spreadText(spread, field, sfmt, median) {
  const s = spread?.[field];
  if (!s || !fmt.isNum(median)) return '';
  const f = sfmt(median);
  const lo = f(s[0]);
  const hi = f(s[1]);
  return lo === hi ? '' : `${lo}–${hi}`;
}

export const DIMM_CELL_COUNT = DIMM_CELLS;
