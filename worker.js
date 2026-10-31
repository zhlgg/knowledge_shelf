/* Pyodide worker of the online bookshelf (reader/shelf), started by shim.js the first time Python is needed.
   Lays the repo's text files out under /kb (plus this device's overlay), runs shelf_api.py → reader/server.py, and
   commits a written comment straight to GitHub (Contents API, with the token from the manifest). On success the
   note and its fresh /api answers go into the overlay, so this device sees the comment before the site is rebuilt. */
import './crypt.js';
import { loadPyodide } from './py/pyodide.mjs';

const BASE = new URL('./', import.meta.url).pathname;
const enc = new TextEncoder(), dec = new TextDecoder();
let booting = null;
let checked = 0;
let queue = Promise.resolve();

async function boot() {
  const st = await Shelf.get('kv', 'key');
  if (!st) throw new Error('书架还没解锁');
  const glue = fetch(BASE + 'shelf_api.py').then((r) => { if (!r.ok) throw new Error('shelf_api.py HTTP ' + r.status); return r.text(); });
  const pyodide = loadPyodide({ indexURL: BASE + 'py/' });
  const site = await Shelf.site(BASE);
  const man = await Shelf.manifest(BASE, st.key, site);
  if (!man.py) throw new Error('这次构建没有带 Pyodide');
  const w = { py: await pyodide, key: st.key, site, man };
  await layout(w, man);
  w.py.runPython(await glue);
  for (const name of ['search', 'comment', 'restore', 'payloads', 'reset']) w[name] = w.py.globals.get(name);
  checked = Date.now();
  return w;
}

// /kb = the build's corpus + the notes this device committed that the build does not have yet
async function layout(w, man) {
  await Shelf.prune(man);
  const corpus = JSON.parse(dec.decode(await Shelf.blob(BASE, w.key, man.files.corpus)));
  w.py.runPython("import shutil; shutil.rmtree('/kb', ignore_errors=True)");
  const write = (rel, text) => {
    const full = '/kb/' + rel;
    w.py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    w.py.FS.writeFile(full, text);
  };
  for (const [rel, text] of Object.entries(corpus)) write(rel, text);
  for (const [k, v] of await Shelf.entries('ov')) if (k.startsWith('file:')) write(k.slice(5), v.text);
}

// the site may have been rebuilt since Python started (a comment from the Mac, a new note): lay it out again, or
// a comment would be checked against an old copy of its note and refused forever
async function start(fresh) {
  if (!booting) booting = boot().catch((err) => { booting = null; throw err; });
  const w = await booting;
  if (fresh || Date.now() - checked > 60e3) {
    checked = Date.now();
    const site = await Shelf.site(BASE).catch(() => null);
    if (site && site.manifest !== w.site.manifest) {
      const man = await Shelf.manifest(BASE, w.key, site);
      await layout(w, man);
      w.reset();
      w.site = site;
      w.man = man;
    }
  }
  return w;
}

self.onmessage = ({ data }) => {
  const { id, op, args } = data;
  const run = queue.then(async () => {
    if (op === 'warm') { await start(false); return { status: 200, body: { ok: true } }; }
    if (op === 'search') return JSON.parse((await start(false)).search(args.qs));
    if (op === 'comment') return comment(await start(true), args.req);
    return { status: 400, body: { error: 'unknown op ' + op } };
  }).catch((err) => ({ status: 500, body: { error: '网页版出错：' + (err && err.message || err) } }));
  queue = run;
  run.then((out) => self.postMessage({ id, ...out }));
};

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function blobSha(text) {           // git's object id of the note as the site has it
  const body = enc.encode(text), head = enc.encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head);
  all.set(body, head.length);
  return hex(await crypto.subtle.digest('SHA-1', all));
}
function b64(text) {
  const bytes = enc.encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function comment(w, req) {
  const r = JSON.parse(w.comment(JSON.stringify(req)));
  if (r.status !== 200) return { status: r.status, body: r.body };      // the same refusals as on the Mac
  const fail = (status, error) => { w.restore(r.file, r.before); return { status, body: { error } }; };
  const { repo, branch, token } = w.man;
  if (!token) return fail(503, '网页版还没配置 GitHub 写入权限（SHELF_GH_TOKEN），这条评论没有保存');
  const api = `https://api.github.com/repos/${repo}/contents/` + r.file.split('/').map(encodeURIComponent).join('/');
  const hdr = { Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' };
  const name = r.file.split('/').slice(-2).join('/');
  let res;
  try {
    res = await fetch(api, {
      method: 'PUT',
      headers: { ...hdr, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ message: `评论 · ${name}（网页版）`, content: b64(r.after), sha: await blobSha(r.before), branch }),
    });
  } catch (err) {
    return fail(502, '连不上 GitHub，评论没有保存（' + err.message + '）');
  }
  if (res.status === 409) {
    // GitHub has a newer version of this note (written on the Mac or another device, not built yet): take it in,
    // then answer 409 like the Mac does, so the reader reloads the section and keeps the draft
    w.restore(r.file, r.before);
    try { await refresh(w, r.file, api, hdr); } catch (_) { /* the reload then shows the site's version */ }
    return { status: 409, body: { error: '这条笔记刚在别处改过' } };
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch (_) { /* not json */ }
    return fail(502, `GitHub 拒绝了写入（HTTP ${res.status}${msg ? '：' + msg : ''}），评论没有保存`);
  }
  await remember(w, r.file, r.after, (await res.json()).commit.sha);
  return { status: 200, body: r.body };
}

async function remember(w, file, text, commit) {
  const ts = Date.now();
  await Shelf.put('ov', 'file:' + file, { text, commit, ts });
  for (const [k, body] of Object.entries(JSON.parse(w.payloads(file)))) await Shelf.put('ov', 'api:' + k, { body, commit, ts });
}

async function refresh(w, file, api, hdr) {
  const q = '?ref=' + encodeURIComponent(w.man.branch);
  const [text, log] = await Promise.all([
    fetch(api + q, { headers: { ...hdr, Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }),
    fetch(`https://api.github.com/repos/${w.man.repo}/commits?sha=${encodeURIComponent(w.man.branch)}&path=${encodeURIComponent(file)}&per_page=1`,
      { headers: { ...hdr, Accept: 'application/vnd.github+json' }, cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
  ]);
  w.restore(file, text);
  await remember(w, file, text, log[0].sha);
}
