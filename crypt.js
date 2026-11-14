/* Shared by the password page, the service worker and the Pyodide worker of the online bookshelf (reader/shelf).
   Defines self.Shelf. IndexedDB "kr-shelf":
     kv  "key"           { key: CryptoKey (AES-GCM, not extractable), salt, iter }: this device is unlocked
         "mirror"        { root: FileSystemDirectoryHandle, where }: the folder 「⬇ 更新到本地文件夹」 writes (mirror.js)
     ov  "file:<path>"   { text, commit, ts }  a note as this device committed it to GitHub
         "api:<vpath>"   { body, commit, ts }  the matching /api/section and /api/tree answers
   The overlay (ov) is what this device wrote that the published site does not contain yet; an entry is dropped
   once the site's manifest lists its commit among the built ones (or after 7 days). */
(() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('kr-shelf', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('ov'); };
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); dbp = null; }; res(r.result); };
    r.onerror = () => { dbp = null; rej(r.error); };
  }));
  const done = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const committed = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });
  const store = async (name, mode) => (await db()).transaction(name, mode).objectStore(name);

  async function get(name, key) { return done((await store(name)).get(key)); }
  async function put(name, key, val) { const s = await store(name, 'readwrite'); s.put(val, key); return committed(s.transaction); }
  async function del(name, key) { const s = await store(name, 'readwrite'); s.delete(key); return committed(s.transaction); }
  async function clear(name) { const s = await store(name, 'readwrite'); s.clear(); return committed(s.transaction); }
  async function entries(name) {
    const s = await store(name);
    const [k, v] = await Promise.all([done(s.getAllKeys()), done(s.getAll())]);
    return k.map((x, i) => [x, v[i]]);
  }

  async function deriveKey(password, site) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(site.salt), iterations: site.iter }, base, 512);
    return crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['decrypt']);
  }
  const open = (key, buf) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
  const gunzip = (buf) => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  // a wrong password (or a site rebuilt under a new one) fails the GCM check with an OperationError
  const isWrongKey = (err) => !!err && err.name === 'OperationError';

  async function site(base) {
    const r = await fetch(base + 'site.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('site.json HTTP ' + r.status);
    return r.json();
  }
  async function manifest(base, key, s) {
    const r = await fetch(base + s.manifest);
    if (!r.ok) throw new Error('manifest HTTP ' + r.status);
    return JSON.parse(dec.decode(await gunzip(await open(key, await r.arrayBuffer()))));
  }
  // blob names are content hashes, so a cached blob never goes stale. keep = false: use the cache but don't fill it
  // (the local-folder copy reads every file once)
  async function cipher(base, name, keep = true) {
    const url = base + 'b/' + name;
    let cache = null;
    try { cache = await caches.open('kr-shelf-b'); } catch (_) { /* no Cache Storage (private mode) */ }
    let r = cache && await cache.match(url);
    if (!r) {
      r = await fetch(url);
      if (!r.ok) throw new Error('blob HTTP ' + r.status);
      if (cache && keep) await cache.put(url, r.clone()).catch(() => {});
    }
    return r.arrayBuffer();
  }
  async function blob(base, key, ent, keep = true) {
    const plain = await open(key, await cipher(base, ent[0], keep));
    return ent[3] ? gunzip(plain) : plain;
  }

  async function prune(man) {
    const built = new Set(man.recent || []), now = Date.now();
    for (const [k, v] of await entries('ov')) {
      if (!v || built.has(v.commit) || now - (v.ts || 0) > 7 * 864e5) await del('ov', k);
    }
  }
  async function pruneCache(base, man) {
    const keep = new Set(Object.values(man.files).map((e) => base + 'b/' + e[0]));
    const cache = await caches.open('kr-shelf-b');
    for (const r of await cache.keys()) if (!keep.has(new URL(r.url).pathname)) await cache.delete(r);
  }
  async function forget() {
    await Promise.all([del('kv', 'key'), clear('ov'), caches.delete('kr-shelf-b').catch(() => {})]);
  }

  self.Shelf = { get, put, del, clear, entries, deriveKey, isWrongKey, site, manifest, blob, prune, pruneCache, forget };
})();
