// Küçük DOM yardımcıları. API'den gelen metinler daima textContent ile yazılır (innerHTML yok).

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

/** Yalnızca değiştiyse metni yazar (gereksiz yeniden boyamayı önler). */
export function setText(node, text) {
  if (!node) return;
  const t = text ?? '';
  if (node.textContent !== t) node.textContent = t;
}

export function toggle(node, cls, on) {
  if (node && node.classList.contains(cls) !== !!on) node.classList.toggle(cls, !!on);
}

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Sayıyı hedef değere sayarak götürür (hareket azaltma tercihine saygılı).
 * fmt: sayı -> metin
 */
export function countTo(node, target, fmt, { duration = 750, animate = true } = {}) {
  if (!node) return;
  if (typeof target !== 'number' || !Number.isFinite(target)) {
    node._target = undefined;
    node._value = undefined;
    cancelAnimationFrame(node._raf);
    setText(node, fmt(target));
    return;
  }
  if (node._target === target) return;
  const from = typeof node._value === 'number' ? node._value : 0;
  node._target = target;
  cancelAnimationFrame(node._raf);
  if (!animate || reducedMotion() || from === target) {
    node._value = target;
    setText(node, fmt(target));
    return;
  }
  const t0 = performance.now();
  // rAF kısıtlanırsa (arka plan sekmesi, başsız tarayıcı) ara değerde takılı kalmasın: süre sonunda kesin değeri yaz
  clearTimeout(node._settle);
  node._settle = setTimeout(() => {
    if (node._target !== target) return;
    cancelAnimationFrame(node._raf);
    node._value = target;
    setText(node, fmt(target));
  }, duration + 150);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / duration);
    const e = 1 - Math.pow(1 - k, 3);
    const v = from + (target - from) * e;
    node._value = k >= 1 ? target : v;
    setText(node, fmt(k >= 1 ? target : v));
    if (k < 1) node._raf = requestAnimationFrame(step);
  };
  node._raf = requestAnimationFrame(step);
}

/** Canlı değer: animasyonsuz yaz ve iç durumu güncelle */
export function setLive(node, value, fmt) {
  if (!node) return;
  cancelAnimationFrame(node._raf);
  node._target = undefined;
  node._value = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  setText(node, fmt(value));
}
