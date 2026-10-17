/* Service worker of the online bookshelf (reader/shelf). Answers the reader's absolute URLs — /static/ /raw/
   /api/tree /api/section /api/glossary /arxiv-pdf/ — from the encrypted blobs, so reader/static runs unchanged.
   Navigations to the site root get the reader once this device is unlocked, else the password page (index.html
   from the network). /api/search, /api/comment and the chat never reach here: shim.js answers them in the page. */
importScripts('./crypt.js');

const BASE = new URL('./', self.location.href).pathname;
const ROUTES = ['/static/', '/raw/', '/api/', '/arxiv-pdf/'];
const SERVED_API = (k) => k === 'api/tree' || k === 'api/glossary' || k.startsWith('api/section/');
let cur = null;        // { key, salt, site, man, at }
let loading = null;
let lastErr = '';      // why the last load failed, when it was not a wrong key

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => { if (e.data === 'reset') cur = null; });

// the manifest is re-read on every navigation and at most every 5 min otherwise; offline, the last one stays
function load(fresh) {
  if (cur && !fresh && Date.now() - cur.at < 300e3) return Promise.resolve(cur);
  return loading || (loading = (async () => {
    try {
      const st = await Shelf.get('kv', 'key');
      if (!st) return (cur = null);
      const site = await Shelf.site(BASE);
      if (cur && cur.site.manifest === site.manifest && cur.salt === st.salt) { cur.at = Date.now(); return cur; }
      const man = await Shelf.manifest(BASE, st.key, site);
      cur = { key: st.key, salt: st.salt, site, man, at: Date.now() };
      lastErr = '';
      Shelf.prune(man).catch(() => {});
      Shelf.pruneCache(BASE, man).catch(() => {});
      return cur;
    } catch (err) {
      if (Shelf.isWrongKey(err)) cur = null;
      else lastErr = err.message || String(err);
      return cur;
    } finally {
      loading = null;
    }
  })());
}

// Hosted in a sub-folder (user.github.io/shelf/), the reader's absolute URLs also arrive as /shelf/static/… etc.:
// shim.js moves the pdf.js worker and new-tab /raw/ links there, so they fall inside this worker's scope
function route(pathname) {
  if (BASE !== '/' && pathname.startsWith(BASE)) {
    const p = '/' + pathname.slice(BASE.length);
    if (ROUTES.some((r) => p.startsWith(r))) return p;
  }
  return ROUTES.some((r) => pathname.startsWith(r)) ? pathname : null;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate' && (url.pathname === BASE || url.pathname === BASE + 'index.html')) {
    e.respondWith(page(e.request, url));
    return;
  }
  const path = route(url.pathname);
  if (path) {
    e.respondWith(serve(e.request, path, url.searchParams));
  } else if (url.pathname.startsWith(BASE) && e.request.method === 'GET' && e.request.mode !== 'navigate'
             && !/^[bm]\//.test(url.pathname.slice(BASE.length))) {
    // this site's own code (shim.js, worker.js, py/…) must match the service worker after a deploy: revalidate it;
    // b/ and m/ are named by their content and stay cached
    e.respondWith(fetch(e.request, { cache: 'no-cache' }));
  }
});

async function page(request, url) {
  if (url.searchParams.has('logout')) return fetch(request);
  const c = await load(true);
  const ent = c && c.man.files['static/index.html'];
  if (!ent) return fetch(request);
  try {
    const body = await Shelf.blob(BASE, c.key, ent);
    return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (_) {
    return fetch(request);
  }
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj),
  { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

async function serve(request, path, params) {
  if (path.startsWith('/arxiv-pdf/')) return arxiv(request, path.slice('/arxiv-pdf/'.length));
  let c = await load(false);
  if (!c) return lastErr ? json({ error: '暂时打不开书架：' + lastErr }, 503) : json({ error: '书架还没解锁' }, 401);
  let key;
  try { key = decodeURIComponent(path.slice(1)); } catch (_) { return json({ error: 'bad path' }, 400); }
  if (key === 'api/section') key = 'api/section/' + (params.get('id') || '');
  if (key.startsWith('api/')) {
    if (!SERVED_API(key)) return json({ error: '网页版没有这个接口' }, 404);
    const ov = await Shelf.get('ov', 'api:' + key).catch(() => null);
    if (ov) return json(ov.body);
  }
  let ent = c.man.files[key];
  if (!ent) {
    return key.startsWith('api/section/') ? json({ error: 'section not found', id: params.get('id') }, 404)
      : new Response('Not found', { status: 404 });
  }
  let body;
  try {
    body = await Shelf.blob(BASE, c.key, ent);
  } catch (err) {
    // the site was rebuilt and this blob is gone: take the new manifest and try once more
    c = await load(true);
    ent = c && c.man.files[key];
    if (!ent) return new Response('Not found', { status: 404 });
    try { body = await Shelf.blob(BASE, c.key, ent); } catch (e) { return new Response(String(e.message || e), { status: 502 }); }
  }
  return new Response(body, { headers: { 'Content-Type': ent[2], 'Cache-Control': 'no-cache' } });
}

// The paper view's PDF, the exact arXiv version the notes were anchored on. arXiv sends CORS headers and honours
// Range, so pdf.js can fetch just the pages it needs. arXiv answers preflights without CORS headers, though, so a
// browser that preflights Range gets the whole file once instead, and its ranges are cut from that.
const pdfs = new Map();      // version → Promise<Blob>, the last few whole files
async function arxiv(request, version) {
  if (!/^[\w.\/-]+v\d+$/.test(version)) return new Response('bad arXiv id', { status: 400 });
  const src = 'https://arxiv.org/pdf/' + version;
  const range = request.headers.get('Range');
  try {
    if (range && !pdfs.has(version)) {
      try {
        return pass(await fetch(src, { headers: { Range: range }, mode: 'cors', credentials: 'omit', signal: request.signal }));
      } catch (err) {
        if (request.signal.aborted) throw err;
      }
    }
    if (range) return cut(await whole(src, version), range);
    return pass(await fetch(src, { mode: 'cors', credentials: 'omit', signal: request.signal }));
  } catch (err) {
    return new Response('arXiv unreachable: ' + err.message, { status: 502 });
  }
}

function pass(r) {
  const h = new Headers({ 'Content-Type': 'application/pdf', 'Accept-Ranges': 'bytes' });
  for (const k of ['Content-Length', 'Content-Range']) { const v = r.headers.get(k); if (v) h.set(k, v); }
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

function whole(src, version) {
  if (!pdfs.has(version)) {
    const p = fetch(src, { mode: 'cors', credentials: 'omit' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); });
    p.catch(() => pdfs.delete(version));
    pdfs.set(version, p);
    while (pdfs.size > 3) pdfs.delete(pdfs.keys().next().value);
  }
  return pdfs.get(version);
}

function cut(blob, range) {
  const size = blob.size, m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let a = -1, b = -1;
  if (m && m[1] !== '') { a = +m[1]; b = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  else if (m && m[2] !== '') { a = Math.max(0, size - +m[2]); b = size - 1; }
  if (a < 0 || a > b) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(a, b + 1), { status: 206, headers: { 'Content-Type': 'application/pdf', 'Accept-Ranges': 'bytes',
    'Content-Length': String(b - a + 1), 'Content-Range': `bytes ${a}-${b}/${size}` } });
}
