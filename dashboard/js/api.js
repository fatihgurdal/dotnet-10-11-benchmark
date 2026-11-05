// Benchmark API istemcisi: /api/info, /api/workloads, /api/run/{id}/stream (SSE), /api/gc/collect
// SSE, fetch + ReadableStream ile okunur: böylece HTTP durum kodu (404/409) görülebilir ve
// EventSource'un otomatik yeniden bağlanması (testi baştan başlatması) hiç yaşanmaz.

export const RUNTIMES = ['net10', 'net11'];

export const DEFAULT_BASES = { net10: '/bench10', net11: '/bench11' };
const QUERY_KEYS = { net10: 'b10', net11: 'b11' };

/** Taban URL'yi doğrular: yalnızca http(s) mutlak URL ya da "/" ile başlayan göreli yol. */
function sanitizeBase(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  if (v.startsWith('/') && !v.startsWith('//')) return v.replace(/\/+$/, '') || '/';
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function resolveBases(search = location.search) {
  const params = new URLSearchParams(search);
  const out = {};
  for (const rt of RUNTIMES) {
    out[rt] = sanitizeBase(params.get(QUERY_KEYS[rt])) ?? DEFAULT_BASES[rt];
  }
  return out;
}

export class ApiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind; // 'busy' | 'notfound' | 'http' | 'network' | 'timeout' | 'protocol' | 'server' | 'aborted'
    this.status = status;
  }
}

function joinUrl(base, path) {
  return base.replace(/\/+$/, '') + path;
}

/** Zaman aşımı + dış abort sinyali birleştirilmiş fetch */
async function fetchWithTimeout(url, { timeoutMs = 8000, signal, ...init } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch (err) {
    if (signal?.aborted) throw new ApiError('aborted', 'İptal edildi');
    if (timedOut) throw new ApiError('timeout', 'Sunucu zamanında yanıt vermedi');
    throw new ApiError('network', 'Sunucuya ulaşılamadı');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readJsonSafe(res) {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function getJson(base, path, opts) {
  const res = await fetchWithTimeout(joinUrl(base, path), { headers: { Accept: 'application/json' }, ...opts });
  const body = await readJsonSafe(res);
  if (!res.ok) throw httpError(res.status, body);
  if (body === null) throw new ApiError('protocol', 'Geçersiz JSON yanıtı', res.status);
  return body;
}

function httpError(status, body) {
  if (status === 409) return new ApiError('busy', 'Sunucu şu anda başka bir testi çalıştırıyor', 409);
  if (status === 404) return new ApiError('notfound', body?.error || body?.message || 'İş yükü bulunamadı', 404);
  return new ApiError('http', `HTTP ${status}${body?.error ? ' – ' + body.error : ''}`, status);
}

export function getInfo(base, opts) {
  return getJson(base, '/api/info', { timeoutMs: 6000, ...opts }).then((info) => {
    if (typeof info !== 'object' || Array.isArray(info)) throw new ApiError('protocol', 'Beklenmeyen /api/info yanıtı');
    return info;
  });
}

export async function getWorkloads(base, opts) {
  const list = await getJson(base, '/api/workloads', { timeoutMs: 8000, ...opts });
  if (!Array.isArray(list)) throw new ApiError('protocol', 'Beklenmeyen /api/workloads yanıtı');
  return list
    .filter((w) => w && typeof w.id === 'string' && w.id)
    .map((w) => ({
      id: w.id,
      category: str(w.category),
      title: str(w.title),
      titleTr: str(w.titleTr) || str(w.title) || w.id,
      descriptionTr: str(w.descriptionTr),
      icon: str(w.icon),
      unit: str(w.unit),
      defaultScale: typeof w.defaultScale === 'number' ? w.defaultScale : 1,
    }));
}

export async function collectGc(base) {
  const res = await fetchWithTimeout(joinUrl(base, '/api/gc/collect'), { method: 'POST', timeoutMs: 10000 });
  const body = await readJsonSafe(res);
  if (!res.ok) throw httpError(res.status, body);
  return body;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

/* ------------------------------------------------------------------ */
/* SSE akışı                                                            */
/* ------------------------------------------------------------------ */

const KNOWN_EVENTS = new Set(['start', 'phase', 'progress', 'result', 'error']);

/**
 * Bir testi çalıştırır ve olayları işleyicilere iletir.
 * handlers: { onStart, onPhase, onProgress }
 * Sonuç olayıyla çözülür; error olayı, kopma, zaman aşımı ve iptalde ApiError ile reddedilir.
 */
export async function runStream(base, workloadId, { scale = 1, warmup = true } = {}, handlers = {}, signal) {
  const qs = new URLSearchParams({ scale: String(scale), warmup: warmup ? '1' : '0' });
  const url = joinUrl(base, `/api/run/${encodeURIComponent(workloadId)}/stream?${qs}`);

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) throw new ApiError('aborted', 'İptal edildi');
    signal.addEventListener('abort', onAbort, { once: true });
  }

  // Bağlantı zaman aşımı (başlıklar gelene kadar) ve boşta kalma zaman aşımı (olaysız süre).
  // Isınma turunda ilerleme olayı gelmeyebileceği için boşta kalma süresi cömert tutulur.
  const CONNECT_TIMEOUT = 15000;
  const IDLE_TIMEOUT = 180000;
  let timeoutKind = null;
  let timer = setTimeout(() => { timeoutKind = 'connect'; ctrl.abort(); }, CONNECT_TIMEOUT);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timeoutKind = 'idle'; ctrl.abort(); }, IDLE_TIMEOUT);
  };

  const fail = (err) => {
    if (signal?.aborted) return new ApiError('aborted', 'İptal edildi');
    if (timeoutKind) return new ApiError('timeout', timeoutKind === 'connect' ? 'Sunucu bağlantısı zaman aşımına uğradı' : 'Sunucudan uzun süre veri gelmedi');
    if (err instanceof ApiError) return err;
    return new ApiError('network', 'Bağlantı koptu');
  };

  let reader;
  try {
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'text/event-stream' }, cache: 'no-store' });
    } catch (err) {
      throw fail(err);
    }
    if (!res.ok) {
      const body = await readJsonSafe(res);
      throw httpError(res.status, body);
    }
    if (!res.body) throw new ApiError('protocol', 'Tarayıcı akış okumayı desteklemiyor');
    bump();

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    let started = false;
    let pendingCR = false;

    const dispatch = (evt) => {
      const type = evt.event || 'message';
      if (!KNOWN_EVENTS.has(type)) return;
      let data = null;
      if (evt.data) {
        try { data = JSON.parse(evt.data); } catch { return; } // bozuk olay: yok say
      }
      if (data === null || typeof data !== 'object') data = {};
      switch (type) {
        case 'start': started = true; handlers.onStart?.(data); break;
        case 'phase': handlers.onPhase?.(data); break;
        case 'progress': handlers.onProgress?.(data); break;
        case 'result': result = data; break;
        case 'error': throw new ApiError('server', typeof data.message === 'string' && data.message ? data.message : 'Sunucu hatası');
      }
    };

    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw fail(err);
      }
      if (chunk.done) break;
      bump();
      // Olaylar boş satırla ayrılır (\n\n, \r\n\r\n veya \r\r); satır sonlarını \n'e normalleştir.
      let text = decoder.decode(chunk.value, { stream: true });
      if (pendingCR) { text = '\r' + text; pendingCR = false; }
      if (text.endsWith('\r')) { pendingCR = true; text = text.slice(0, -1); }
      buffer += text.replace(/\r\n?/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evt = parseBlock(block);
        if (evt) dispatch(evt);
        if (result) break;
      }
      if (result) break;
      if (buffer.length > 4_000_000) throw new ApiError('protocol', 'Akış tamponu taştı');
    }
    if (!result && buffer.trim()) {
      const evt = parseBlock(buffer);
      if (evt) dispatch(evt);
    }
    if (!result) throw new ApiError('protocol', started ? 'Akış sonuç gelmeden kapandı' : 'Akış beklenmedik şekilde kapandı');
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // Akışı her durumda kapat: sunucu iptali algılar, tarayıcı yeniden bağlanmaz.
    try { await reader?.cancel(); } catch { /* yok say */ }
    ctrl.abort();
  }
}

function parseBlock(block) {
  let event = '';
  const data = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!event && !data.length) return null;
  return { event, data: data.join('\n') };
}
