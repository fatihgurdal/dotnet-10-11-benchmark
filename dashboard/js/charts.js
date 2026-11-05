// El yazımı SVG çizgi grafikleri (bağımlılık yok). Gerçek piksel boyutunda çizilir; ResizeObserver ile yeniden çizilir.

const NS = 'http://www.w3.org/2000/svg';
let uid = 0;

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

/** "Güzel" eksen adımları */
function niceStep(range, ticks) {
  const raw = range / Math.max(1, ticks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

function niceBytesMax(v) {
  if (v <= 0) return 1024 * 1024;
  const units = [1, 1024, 1024 ** 2, 1024 ** 3];
  let u = units[0];
  for (const x of units) if (v >= x) u = x;
  const n = v / u;
  const step = niceStep(n, 4);
  return Math.ceil(n / step) * step * u;
}

/**
 * opts: { yMax: number|null (null => otomatik), yKind: 'percent'|'bytes', yFormat, xFormat, ariaLabel }
 */
export function createLineChart(container, opts) {
  const id = ++uid;
  const svg = el('svg', { class: 'chart-svg', role: 'img', 'aria-label': opts.ariaLabel || '' });
  container.appendChild(svg);
  const defs = el('defs', {}, svg);
  const glow = el('filter', { id: `glow${id}`, x: '-20%', y: '-50%', width: '140%', height: '200%' }, defs);
  el('feGaussianBlur', { stdDeviation: '3', result: 'b' }, glow);
  const merge = el('feMerge', {}, glow);
  el('feMergeNode', { in: 'b' }, merge);
  el('feMergeNode', { in: 'SourceGraphic' }, merge);

  const gGrid = el('g', { class: 'chart-grid' }, svg);
  const gArea = el('g', { class: 'chart-areas' }, svg);
  const gLines = el('g', { class: 'chart-lines' }, svg);
  const gDots = el('g', { class: 'chart-dots' }, svg);
  const empty = el('text', { class: 'chart-empty', 'text-anchor': 'middle' }, svg);
  empty.textContent = opts.emptyText || 'Veri bekleniyor';

  let data = { series: [], xMax: 0 };
  let w = 0;
  let h = 0;
  const gradients = new Map();

  function gradientFor(color) {
    if (gradients.has(color)) return gradients.get(color);
    const gid = `grad${id}_${gradients.size}`;
    const g = el('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '0.28' }, g);
    el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0' }, g);
    gradients.set(color, gid);
    return gid;
  }

  function draw() {
    if (!w || !h) return;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    gGrid.replaceChildren();
    gArea.replaceChildren();
    gLines.replaceChildren();
    gDots.replaceChildren();

    const fs = parseFloat(getComputedStyle(container).fontSize) || 12;
    const padL = Math.round(fs * 4.6);
    const padR = Math.round(fs * 0.9);
    const padT = Math.round(fs * 0.8);
    const padB = Math.round(fs * 1.9);
    const iw = Math.max(10, w - padL - padR);
    const ih = Math.max(10, h - padT - padB);

    let yMaxData = 0;
    let xMax = data.xMax || 0;
    let hasPoints = false;
    for (const s of data.series) {
      for (const [x, y] of s.points) {
        if (y > yMaxData) yMaxData = y;
        if (x > xMax) xMax = x;
        hasPoints = true;
      }
    }
    const yMax = opts.yMax ?? (opts.yKind === 'bytes' ? niceBytesMax(yMaxData * 1.08) : Math.max(1, yMaxData * 1.1));
    xMax = Math.max(xMax, 1);
    const xStep = niceStep(xMax, Math.max(2, Math.floor(iw / (fs * 6))));
    xMax = Math.ceil(xMax / xStep) * xStep;

    const sx = (x) => padL + (x / xMax) * iw;
    const sy = (y) => padT + ih - (Math.min(y, yMax) / yMax) * ih;

    // Yatay ızgara + y etiketleri
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const v = (yMax / yTicks) * i;
      const y = sy(v);
      el('line', { x1: padL, x2: padL + iw, y1: y, y2: y, class: i === 0 ? 'axis' : 'grid' }, gGrid);
      const t = el('text', { x: padL - fs * 0.6, y: y + fs * 0.35, 'text-anchor': 'end', class: 'tick' }, gGrid);
      t.textContent = opts.yFormat(v);
    }
    // x etiketleri
    for (let x = 0; x <= xMax + 1e-9; x += xStep) {
      const px = sx(x);
      el('line', { x1: px, x2: px, y1: padT + ih, y2: padT + ih + fs * 0.35, class: 'axis' }, gGrid);
      const t = el('text', { x: px, y: padT + ih + fs * 1.45, 'text-anchor': 'middle', class: 'tick' }, gGrid);
      t.textContent = opts.xFormat(x);
    }

    empty.setAttribute('x', padL + iw / 2);
    empty.setAttribute('y', padT + ih / 2);
    empty.style.display = hasPoints ? 'none' : '';

    for (const s of data.series) {
      if (!s.points.length) continue;
      const pts = s.points.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`);
      const d = 'M' + pts.join('L');
      if (s.area) {
        const last = s.points[s.points.length - 1];
        const first = s.points[0];
        el('path', {
          d: `${d}L${sx(last[0]).toFixed(1)},${sy(0)}L${sx(first[0]).toFixed(1)},${sy(0)}Z`,
          fill: `url(#${gradientFor(s.color)})`,
          class: 'area',
        }, gArea);
      }
      el('path', {
        d,
        fill: 'none',
        stroke: s.color,
        'stroke-width': s.width || 2.2,
        'stroke-dasharray': s.dash || '',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        filter: s.glow === false ? '' : `url(#glow${id})`,
        class: 'line',
      }, gLines);
      if (s.live) {
        const [lx, ly] = s.points[s.points.length - 1];
        el('circle', { cx: sx(lx), cy: sy(ly), r: 4, fill: s.color, class: 'dot live' }, gDots);
      }
    }
  }

  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const cr = e.contentRect;
      const nw = Math.round(cr.width);
      const nh = Math.round(cr.height);
      if (nw !== w || nh !== h) {
        w = nw;
        h = nh;
        draw();
      }
    }
  });
  ro.observe(container);

  return {
    update(next) {
      data = next;
      draw();
    },
    redraw: draw,
  };
}
