/* 「⬇ 更新到本地文件夹」 of the online bookshelf (reader/shelf), loaded by shim.js on the first click.
   Copies the repository as the current build has it into a folder on this computer, laid out like `git clone` without
   .git: the manifest's raw/ + src/ entries are exactly `git archive` (build.py), plus the notes this device committed
   that the site does not contain yet (the ov overlay). No PDFs: they are not in the repository either.
   Chromium on a computer only (File System Access API). The folder handle is remembered in IndexedDB kv "mirror".

   The folder keeps .shelf-sync.json = { source, built, at, files: { path: [blob, sha256 of the bytes written] } }:
     unchanged on the site                     → left alone; a file deleted here is put back
     changed on the site, untouched here       → rewritten
     edited here                               → kept and reported, never overwritten (delete it, update, get ours)
     gone from the site                        → deleted if untouched here, else kept, reported once and forgotten
     a file we never wrote is in the way       → kept and reported, unless it already holds the same bytes
   A folder that holds .git is refused: git would take every written file for a local edit; `git pull` updates it. */

const STATE = '.shelf-sync.json';
const POOL = 6;
const enc = new TextEncoder();

export const supported = () => typeof window.showDirectoryPicker === 'function';

async function shelf(base) {
  if (!self.Shelf) await import(base + 'crypt.js');
  return self.Shelf;
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (data) => hex(await crypto.subtle.digest('SHA-256', data));
const split = (path) => { const i = path.lastIndexOf('/'); return [path.slice(0, Math.max(i, 0)), path.slice(i + 1)]; };

export class Refused extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function exists(dir, name) {
  for (const get of ['getDirectoryHandle', 'getFileHandle']) {
    try { await dir[get](name); return true; } catch (_) { /* not there as this kind */ }
  }
  return false;
}

async function alive(dir) {
  try { await dir.keys().next(); return true; } catch (err) { if (err.name === 'NotFoundError') return false; throw err; }
}

// directory handles by path, one cache for lookups and one for creating (a failed lookup is not remembered)
function folder(root) {
  const memo = [new Map(), new Map()];
  function dir(path, create) {
    if (!path) return Promise.resolve(root);
    const m = memo[create ? 1 : 0];
    let p = m.get(path);
    if (!p) {
      const [parent, name] = split(path);
      p = dir(parent, create).then((d) => d.getDirectoryHandle(name, { create }));
      m.set(path, p);
      p.catch(() => m.delete(path));
    }
    return p;
  }
  return {
    dir,
    async file(path) {
      const [d, name] = split(path);
      try {
        return await (await (await dir(d, false)).getFileHandle(name)).getFile();
      } catch (err) {
        if (err.name === 'NotFoundError' || err.name === 'TypeMismatchError') return null;
        throw err;
      }
    },
    async write(path, data) {
      const [d, name] = split(path);
      const w = await (await (await dir(d, true)).getFileHandle(name, { create: true })).createWritable();
      try { await w.write(data); await w.close(); } catch (err) { await w.abort().catch(() => {}); throw err; }
    },
    async remove(path) {
      const [d, name] = split(path);
      await (await dir(d, false)).removeEntry(name);
    },
  };
}

// The folder to write: the picked one if it is called knowledge or was written before, else knowledge/ inside it
export async function target(picked) {
  if (picked.name === 'knowledge' || await exists(picked, STATE)) return picked;
  return picked.getDirectoryHandle('knowledge', { create: true });
}

export async function lastSync(root) {
  try {
    const f = await folder(root).file(STATE);
    return f ? JSON.parse(await f.text()) : null;
  } catch (_) {
    return null;
  }
}

// One update of `root`. Returns the counts and the lists to show; throws Refused for a git folder, a vanished
// folder or a locked shelf.
export async function syncInto(root, { base, onProgress = () => {} }) {
  const S = await shelf(base);
  if (!await alive(root)) throw new Refused('gone', '上次的文件夹找不到了（被移动、改名或删掉了）。请点「换个位置…」重新选。');
  if (await exists(root, '.git')) throw new Refused('git', GIT_MSG);
  const key = await S.get('kv', 'key');
  if (!key) throw new Refused('locked', '书架还没解锁，刷新页面输入密码后再试。');
  const site = await S.site(base);
  const man = await S.manifest(base, key.key, site);

  const want = new Map();
  for (const [vpath, ent] of Object.entries(man.files)) {
    const m = /^(?:raw|src)\/(.+)$/.exec(vpath);
    if (m) want.set(m[1], { id: ent[0], get: () => S.blob(base, key.key, ent, false) });
  }
  const built = new Set(man.recent || []), now = Date.now();
  for (const [k, v] of await S.entries('ov').catch(() => [])) {
    const path = k.startsWith('file:') ? k.slice(5) : '';
    if (want.has(path) && v && !built.has(v.commit) && now - (v.ts || 0) < 7 * 864e5) {
      want.set(path, { id: 'ov:' + v.commit, get: async () => enc.encode(v.text) });
    }
  }

  const fs = folder(root);
  const before = await lastSync(root);
  const prev = (before && before.files) || {};
  const files = { ...prev };
  const save = (partial) => fs.write(STATE, enc.encode(JSON.stringify(
    { v: 1, source: man.source, built: man.built, at: Date.now(), partial, files }) + '\n'));
  const r = { added: 0, updated: 0, restored: 0, deleted: 0, same: 0, conflicts: [], kept: [], failed: [] };

  // gone from the site: delete what we wrote and nobody touched since; first, so a file can become a folder
  const emptied = new Set();
  for (const path of Object.keys(prev)) {
    if (want.has(path)) continue;
    try {
      const f = await fs.file(path);
      if (f && await sha(await f.arrayBuffer()) === prev[path][1]) {
        await fs.remove(path);
        r.deleted++;
        emptied.add(split(path)[0]);
      } else if (f) {
        r.kept.push(path);
      }
      delete files[path];
    } catch (err) {
      r.failed.push([path, err.message || String(err)]);
    }
  }

  const todo = [...want.keys()].sort();
  let next = 0, done = 0, writes = 0;
  async function one(path) {
    const w = want.get(path), had = prev[path];
    const f = await fs.file(path);
    if (had && had[0] === w.id && f) { r.same++; return; }
    const data = await w.get(), h = await sha(data);
    if (f) {
      const mine = await sha(await f.arrayBuffer());
      if (mine === h) { files[path] = [w.id, h]; r.same++; return; }
      if (!had || mine !== had[1]) { r.conflicts.push(path); return; }
    }
    await fs.write(path, data);
    files[path] = [w.id, h];
    if (f || (had && had[0] !== w.id)) r.updated++;
    else if (had) r.restored++;
    else r.added++;
    if (++writes % 300 === 0) await save(true).catch(() => {});   // progress so far; the final save is the one that counts
  }
  onProgress(0, todo.length);
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (next < todo.length) {
      const path = todo[next++];
      try { await one(path); } catch (err) { r.failed.push([path, err.message || String(err)]); }
      onProgress(++done, todo.length);
    }
  }));

  // folders left empty by the deletions, deepest first, never the root
  for (const d of [...emptied].sort((a, b) => b.length - a.length)) {
    for (let path = d; path; path = split(path)[0]) {
      try {
        if (!(await (await fs.dir(path, false)).keys().next()).done) break;
        await (await fs.dir(split(path)[0], false)).removeEntry(split(path)[1]);
      } catch (_) {
        break;
      }
    }
  }

  await save(undefined);
  for (const k of ['conflicts', 'kept']) r[k].sort();
  r.failed.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { ...r, total: todo.length, source: man.source, built: man.built, manifest: site.manifest };
}

const GIT_MSG = '这个文件夹是 git 仓库（里面有 .git），请用 git 更新它：在终端里进到这个文件夹，运行 git pull。'
  + '书架往里面写文件，git 会把每个变了的文件都当成你自己的改动，之后的 git pull 反而会被挡住。'
  + '想要一个书架副本，就点「换个位置…」，选一个普通文件夹。';

/* ------------------------------------------------------------------ the panel */

const CSS = `
.kr-mirror { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; background: rgba(30,20,30,.45);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.kr-mirror[hidden] { display: none; }
.kr-mirror-box { width: min(92vw, 560px); max-height: 86vh; display: flex; flex-direction: column; background: var(--paper);
  color: var(--ink); border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow); overflow: hidden;
  font-family: var(--sans); }
.kr-mirror-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 18px;
  border-bottom: 1px dashed var(--line); font-size: 15px; }
.kr-mirror-x { border: 0; background: transparent; color: var(--ink-3); font-size: 16px; cursor: pointer; }
.kr-mirror-body { padding: 14px 18px 4px; overflow: auto; font-size: 13.5px; line-height: 1.75; color: var(--ink-2); }
.kr-mirror-body p { margin: 0 0 10px; }
.kr-mirror-body b { color: var(--ink); }
.kr-mirror-bar { height: 6px; border-radius: 3px; background: var(--paper-2); overflow: hidden; margin: 2px 0 12px; }
.kr-mirror-bar[hidden] { display: none; }
.kr-mirror-bar i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .2s; }
.kr-mirror-list h4 { margin: 10px 0 2px; font-size: 13px; color: var(--ink); }
.kr-mirror-list ul { margin: 2px 0 6px; padding-left: 1.3em; max-height: 150px; overflow: auto; font-size: 12.5px;
  word-break: break-all; }
.kr-mirror-list .hint { font-size: 12.5px; color: var(--ink-3); margin: 0 0 8px; }
.kr-mirror-foot { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 18px 14px; }
.kr-mirror-foot button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--line); background: transparent;
  color: var(--ink-2); font-size: 13px; cursor: pointer; }
.kr-mirror-foot .kr-mirror-go { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.kr-mirror-foot button:disabled { opacity: .5; cursor: default; }
.kr-mirror-foot button[hidden] { display: none; }
`;

const INTRO = '选一个位置，书架会在那里建一个 <b>knowledge</b> 文件夹，把书架里的全部文件按仓库原样放进去'
  + '（目录结构和 GitHub 上的 zhlgg/knowledge 一样；没有 PDF，也没有 .git）。之后再点这个按钮，只更新变了的文件，'
  + '你在本地改过的文件不会被覆盖。<br>直接选一个叫 knowledge 的文件夹也行，就用它。'
  + 'Chrome 不让直接选「桌面」「文稿」「下载」本身：在里面新建一个文件夹再选。';

let BASE = '/';
let ui = null;
let saved = null;           // { root, where } from IndexedDB
let running = false;

function el(tag, text) { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; }
const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('zh-CN', { hour12: false }); };
const sideBtn = () => document.getElementById('btn-mirror');

function panel() {
  if (ui) return ui;
  document.head.appendChild(el('style', CSS));
  const box = el('div');
  box.className = 'kr-mirror';
  box.hidden = true;
  box.innerHTML = `
    <div class="kr-mirror-box" role="dialog" aria-modal="true" aria-labelledby="kr-mirror-title">
      <div class="kr-mirror-head"><b id="kr-mirror-title">⬇ 更新到本地文件夹</b>
        <button class="kr-mirror-x" title="关闭（Esc）" aria-label="关闭">✕</button></div>
      <div class="kr-mirror-body">
        <p class="kr-mirror-where"></p>
        <div class="kr-mirror-bar" hidden><i></i></div>
        <p class="kr-mirror-msg" role="status"></p>
        <div class="kr-mirror-list"></div>
      </div>
      <div class="kr-mirror-foot">
        <button class="kr-mirror-pick">选择位置…</button>
        <button class="kr-mirror-go" hidden>立即更新</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  const q = (s) => box.querySelector(s);
  ui = { box, where: q('.kr-mirror-where'), bar: q('.kr-mirror-bar'), fill: q('.kr-mirror-bar i'), msg: q('.kr-mirror-msg'),
    list: q('.kr-mirror-list'), pick: q('.kr-mirror-pick'), go: q('.kr-mirror-go') };
  q('.kr-mirror-x').addEventListener('click', close);
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  ui.pick.addEventListener('click', pick);
  ui.go.addEventListener('click', run);
  // app.js's keys (Space, T, S, Esc → back to the book …) stay out while the panel is open
  window.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }, true);
  return ui;
}

function close() { if (ui) ui.box.hidden = true; }
function say(msg) { ui.msg.textContent = msg || ''; }

function buttons() {
  ui.go.hidden = !saved;
  ui.go.disabled = running;
  ui.pick.disabled = running;
  ui.pick.textContent = saved ? '换个位置…' : '选择位置…';
}

// the folder line; the time of the last update needs read access, so it is filled in when that is there
async function showWhere(gone) {
  buttons();
  if (!saved) { ui.where.innerHTML = INTRO; return; }
  ui.where.replaceChildren('本地文件夹：', el('b', '📁 …/' + saved.where + (gone ? '（找不到了）' : '')));
  if (gone || await saved.root.queryPermission({ mode: 'read' }).catch(() => '') !== 'granted') return;
  const st = await lastSync(saved.root);
  if (st && st.at) {
    ui.where.append(el('br'), `上次更新 ${when(st.at)}，当时的书架版本是 ${when(st.built)}（${String(st.source || '').slice(0, 7)}）。`);
  }
}

function list(title, items, hint) {
  if (!items.length) return;
  ui.list.append(el('h4', title));
  if (hint) { const p = el('p', hint); p.className = 'hint'; ui.list.append(p); }
  const ul = el('ul');
  for (const x of items.slice(0, 200)) ul.append(el('li', Array.isArray(x) ? `${x[0]} — ${x[1]}` : x));
  if (items.length > 200) ul.append(el('li', `…还有 ${items.length - 200} 个`));
  ui.list.append(ul);
}

function summary(r) {
  const parts = [['新增', r.added], ['更新', r.updated], ['删除', r.deleted], ['补回', r.restored]]
    .filter(([, n]) => n).map(([k, n]) => `${k} ${n}`);
  const head = parts.length ? `更新好了：${parts.join(' · ')}，其余 ${r.same} 个没变。` : `已经是最新的了（${r.same} 个文件都没变）。`;
  return `${head}书架版本 ${when(r.built)}（${String(r.source).slice(0, 7)}）。`;
}

async function pick() {
  if (running) return;
  let picked;
  try {
    picked = await window.showDirectoryPicker({ id: 'kr-mirror', mode: 'readwrite', startIn: 'documents' });
  } catch (err) {
    if (err.name !== 'AbortError') say('选不了这个位置：' + err.message);
    return;
  }
  let root;
  try {
    root = await target(picked);
    if (await exists(root, '.git')) { ui.list.replaceChildren(); say(GIT_MSG); return; }
  } catch (err) {
    say('没法在这里建文件夹：' + err.message);
    return;
  }
  saved = { root, where: root === picked ? root.name : picked.name + '/' + root.name };
  await (await shelf(BASE)).put('kv', 'mirror', saved);
  showWhere();
  run();
}

async function run() {
  if (running || !saved) return;
  running = true;
  buttons();
  const btn = sideBtn();
  try {
    // ask first, while the click that got us here still counts as one
    let perm = await saved.root.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
    if (perm !== 'granted') perm = await saved.root.requestPermission({ mode: 'readwrite' }).catch(() => 'prompt');
    if (perm !== 'granted') { say('需要你允许书架写这个文件夹：点「立即更新」，在弹出的提示里选「允许」。'); return; }

    ui.list.replaceChildren();
    ui.bar.hidden = false;
    ui.fill.style.width = '0';
    say('正在读书架的目录…');
    const progress = (done, total) => {
      const pct = total ? Math.floor(done * 100 / total) : 0;
      ui.fill.style.width = pct + '%';
      say(`正在更新… ${done} / ${total}`);
      if (btn) btn.textContent = `⬇ 更新中 ${pct}%`;
    };
    const S = await shelf(BASE);
    let r = await syncInto(saved.root, { base: BASE, onProgress: progress });
    // the site was rebuilt while we copied, so its old blobs are gone: once more against the new build
    if (r.failed.length && (await S.site(BASE).catch(() => ({}))).manifest !== r.manifest) {
      say('书架刚好重建了一次，再对一遍…');
      r = await syncInto(saved.root, { base: BASE, onProgress: progress });
    }
    await showWhere();
    say(summary(r));
    list(`${r.conflicts.length} 个文件本地是你自己的版本，和书架上的不一样，没有覆盖：`, r.conflicts,
      '你改过它们，或者第一次更新前它们就在这里。想要书架上的版本：把本地这个文件删掉（或改名），再点一次更新。');
    list(`${r.kept.length} 个文件书架上已经删了，但你在本地改过，留着没删：`, r.kept, '以后不再管它们。');
    list(`${r.failed.length} 个文件没写成：`, r.failed, '再点一次更新会重试。');
    if (ui.box.hidden && window.toast) window.toast('本地文件夹：' + summary(r), 6000);
  } catch (err) {
    say(err instanceof Refused ? err.message : '更新失败：' + (err.message || err));
    if (err instanceof Refused && err.code === 'gone') showWhere(true);
    if (ui.box.hidden && window.toast) window.toast('本地文件夹没更新成：' + (err.message || err), 6000);
  } finally {
    running = false;
    ui.bar.hidden = true;
    if (btn) btn.textContent = '⬇ 更新到本地文件夹';
    buttons();
  }
}

// the sidebar button: show the panel; with a folder already chosen, start right away
export async function open(base) {
  BASE = base;
  panel();
  ui.box.hidden = false;
  if (running) return;
  if (!supported()) {
    ui.where.textContent = '';
    say('这个浏览器不能往电脑上的文件夹里写文件。请用电脑上的 Chrome 或 Edge 打开书架再点这个按钮（Safari、Firefox 和手机浏览器都不支持）。');
    ui.pick.hidden = true;
    ui.go.hidden = true;
    return;
  }
  saved = await (await shelf(base)).get('kv', 'mirror').catch(() => null);
  say('');
  ui.list.replaceChildren();
  showWhere();
  if (saved) run();
}
