/* Page shim of the online bookshelf (reader/shelf), injected into the reader's index.html ahead of every other script.
   The service worker serves files and the precomputed answers; what needs code runs here instead:
     GET  /api/search      → worker.js (Pyodide running server.py's search_docs)
     POST /api/comment     → worker.js (server.py's edit_comments, then a commit to GitHub)
     POST /api/progress    → progress.json on the repo's `progress` branch, merged here (app.js's mergeProgress)
     POST /api/chat        → a polite "not here" (看板娘问答 runs opencode on the Mac)
     POST /api/chat/bye, /api/telemetry, GET /api/health → harmless stand-ins
   It also adds the sidebar button 「⬇ 更新到本地文件夹」 (mirror.js: the repository copied into a folder on this computer).
   Python (≈ 13 MB, cached after the first time) starts when the search box or the comment composer opens. */
(() => {
  const BASE = new URL('./', document.currentScript.src).pathname;
  const realFetch = window.fetch.bind(window);
  sessionStorage.removeItem('kr-shelf-go');      // the password page's reload-loop guard: we got here
  navigator.serviceWorker.getRegistration(BASE).then((r) => r && r.update()).catch(() => {});   // after a deploy

  const json = (obj, status = 200) => new Response(JSON.stringify(obj),
    { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  let worker = null, seq = 0, ready = false;
  const waiting = new Map();
  function call(op, args) {
    if (!worker) {
      worker = new Worker(BASE + 'worker.js', { type: 'module' });
      worker.onmessage = ({ data }) => {
        const w = waiting.get(data.id);
        if (!w) return;
        waiting.delete(data.id);
        if (data.status < 500) ready = true;
        w(data);
      };
      worker.onerror = (e) => {
        const err = { status: 500, body: { error: '网页版的 Python 没能启动：' + (e.message || '浏览器不支持 module worker') } };
        for (const w of waiting.values()) w(err);
        waiting.clear();
        worker = null;
      };
    }
    const id = ++seq;
    return new Promise((res) => { waiting.set(id, res); worker.postMessage({ id, op, args }); });
  }
  function slowNotice(p, msg) {
    if (ready) return p;
    const t = setTimeout(() => window.toast && window.toast(msg, 6000), 1200);
    return p.finally(() => clearTimeout(t));
  }
  const warm = () => { if (!worker) call('warm', {}); };

  // Reading progress: the same progress.json on the `progress` branch that the Macs' server.py share (reader/progress.py),
  // read and written with the manifest's token, no Python needed. A PUT carries the sha it merged with, so a write from
  // elsewhere in between makes GitHub refuse it and the merge is simply done again.
  let manP = null;
  const manifest = () => manP || (manP = (async () => {
    if (!self.Shelf) await import(BASE + 'crypt.js');
    const st = await Shelf.get('kv', 'key');
    if (!st) throw new Error('locked');
    return Shelf.manifest(BASE, st.key, await Shelf.site(BASE));
  })().catch((err) => { manP = null; throw err; }));
  const sortDeep = (x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortDeep(x[k])])) : x);
  const canon = (x) => JSON.stringify(sortDeep(x), null, 1) + '\n';      // = progress.py dumps()
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (text) => { const b = enc.encode(text); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => dec.decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  async function progress(mine) {
    let man;
    try { man = await manifest(); } catch (_) { return json({ error: '书架还没解锁' }, 503); }
    const merge = window.KRProgress && window.KRProgress.merge;
    if (!man.token || !merge) return json({ error: '网页版还没配置 GitHub 写入权限（SHELF_GH_TOKEN），阅读进度只存在这个浏览器里' }, 503);
    const api = `https://api.github.com/repos/${man.repo}/contents/progress.json`;
    const hdr = { Authorization: 'Bearer ' + man.token, 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json' };
    try {
      for (let i = 0; i < 4; i++) {
        const res = await realFetch(api + '?ref=progress', { headers: hdr, cache: 'no-store' });
        let theirs = {}, sha;
        if (res.ok) {
          const f = await res.json();
          sha = f.sha;
          try { theirs = JSON.parse(unb64(f.content || '')); } catch (_) { /* unreadable: ours replaces it */ }
        } else if (res.status !== 404) return json({ error: 'GitHub HTTP ' + res.status }, 502);
        const merged = merge([theirs, mine]);
        if (sha && canon(merged) === canon(merge([theirs]))) return json({ ...merged, sync: true });
        const put = await realFetch(api, {
          method: 'PUT', headers: hdr,
          body: JSON.stringify({ message: '阅读进度 · 网页版', content: b64(canon(merged)), branch: 'progress', ...(sha ? { sha } : {}) }),
        });
        if (put.ok) return json({ ...merged, sync: true });
        if (put.status !== 409 && put.status !== 422) return json({ error: 'GitHub 拒绝了写入（HTTP ' + put.status + '）' }, 502);
      }
      return json({ error: 'progress.json 一直在变，下次再同步' }, 502);
    } catch (err) {
      return json({ error: '连不上 GitHub：' + err.message }, 502);
    }
  }

  async function handle(method, url, body, signal) {
    const p = url.pathname;
    if (p === '/api/search' && method === 'GET') {
      const r = await slowNotice(call('search', { qs: url.search }), '第一次搜索要先在浏览器里启动 Python（约 13 MB，之后有缓存），请稍等…');
      return json(r.body, r.status);
    }
    if (p === '/api/comment' && method === 'POST') {
      let req;
      try { req = JSON.parse(body || '{}'); } catch (_) { return json({ error: 'bad json' }, 400); }
      const r = await slowNotice(call('comment', { req }), '正在浏览器里启动 Python 来写评论（第一次约 10 秒）…');
      return json(r.body, r.status);
    }
    if (p === '/api/progress') {
      let mine = {};
      try { mine = JSON.parse(body || '{}'); } catch (_) { return json({ error: 'bad json' }, 400); }
      return progress(method === 'POST' ? mine : {});
    }
    if (p === '/api/chat' && method === 'POST') return chat(body, signal);
    if (p === '/api/chat/bye') { if (llm) llm.forget(); return json({ ok: true }); }
    if (p === '/api/telemetry' || p === '/api/fx') return json({ ok: true });
    if (p === '/api/health') return json({ ok: true, shelf: true, sync: { on: false } });
    return null;
  }

  window.fetch = async function (input, init) {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
      const method = ((init && init.method) || (req && req.method) || 'GET').toUpperCase();
      let body = init && init.body;
      if (body == null && req && method !== 'GET') body = await req.clone().text();
      const signal = (init && init.signal) || (req && req.signal) || undefined;
      const res = await handle(method, url, typeof body === 'string' ? body : body == null ? '' : await new Response(body).text(), signal);
      if (res) return res;
    }
    return realFetch(input, init);
  };

  // 看板娘问答 on the web: llm.js retrieves with this page's own search, asks for confirmation, then streams DeepSeek
  let llm = null;
  async function llmModule() {
    if (!llm) { llm = await import(BASE + 'llm.js'); llm.attach({ call, fetch: realFetch, base: BASE }); }
    return llm;
  }
  function chat(body, signal) {
    let req = {};
    try { req = JSON.parse(body || '{}'); } catch (_) { /* the stream reports it */ }
    const enc = new TextEncoder();
    let ctrl = null, done = false;
    const stream = new ReadableStream({ start(c) { ctrl = c; } });
    const send = (ev) => { if (!done) { try { ctrl.enqueue(enc.encode('data: ' + JSON.stringify(ev) + '\n\n')); } catch (_) { /* reader gone */ } } };
    (async () => {
      try { await (await llmModule()).answer(req, send, signal); }
      catch (err) { send({ t: 'done', ok: false, error: err && err.message ? err.message : String(err) }); }
      finally { done = true; try { ctrl.close(); } catch (_) { /* already closed */ } }
    })();
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  document.addEventListener('focusin', (e) => { if (e.target && e.target.id === 'sm-input') warm(); });
  document.addEventListener('DOMContentLoaded', () => {
    const composer = document.getElementById('cm-composer');
    if (composer) new MutationObserver(() => { if (!composer.hidden) warm(); }).observe(composer, { attributes: true, attributeFilter: ['hidden'] });

    // index.html's 看板娘 footnote names the Mac's opencode model; on the web the answer comes from DeepSeek (llm.js)
    const note = document.querySelector('#mascot-chat .mc-note');
    if (note) note.innerHTML = '网页版的看板娘调 <code>DeepSeek</code>：先在知识库里检索，再把<strong>你要确认的片段</strong>发过去'
      + '（默认宽松检索 + 逐次确认，可在 <strong>⚙ 模型</strong> 里改）· 会话只留在这个标签页，离开本页即清空';

    // 「⬇ 更新到本地文件夹」: a copy of the repository in a folder on this computer (mirror.js, loaded on the first click)
    // next to it ⚙ 模型: the DeepSeek key and model for 看板娘问答 (llm.js). Both web-only; app.js is untouched.
    const foot = document.querySelector('.sidebar-foot');
    if (foot) {
      const row = document.createElement('div');
      row.className = 'sidebar-foot';
      row.innerHTML = '<button class="ghost-btn" id="btn-mirror" style="flex:1" title="把书架里的全部文件放进这台电脑上的 knowledge 文件夹，目录和仓库一样；再点只更新变了的">⬇ 更新到本地文件夹</button>'
        + '<button class="ghost-btn" id="btn-llm" style="flex:0 0 auto" title="看板娘问答用的模型：填 DeepSeek API key、选模型">⚙ 模型</button>';
      foot.after(row);
      row.querySelector('#btn-mirror').addEventListener('click', () => import(BASE + 'mirror.js').then((m) => m.open(BASE))
        .catch((err) => window.toast && window.toast('打不开「更新到本地文件夹」：' + err.message, 5000)));
      row.querySelector('#btn-llm').addEventListener('click', () => llmModule().then((m) => m.openSettings())
        .catch((err) => window.toast && window.toast('打不开模型设置：' + err.message, 5000)));
    }
  });

  // Hosted in a sub-folder (user.github.io/shelf/), a worker or a new tab at /static/… or /raw/… would fall outside
  // the service worker's scope; under /shelf/static/… and /shelf/raw/… it serves them like the originals
  if (BASE !== '/') {
    const inScope = (u) => {
      const x = new URL(u, location.href);
      if (x.origin === location.origin && /^\/(static|raw)\//.test(x.pathname)) x.pathname = BASE + x.pathname.slice(1);
      return x.href;
    };
    const RealWorker = window.Worker;
    window.Worker = class extends RealWorker { constructor(u, o) { super(inScope(u), o); } };
    const fix = (el) => {
      const hits = [...el.querySelectorAll('a[href^="/raw/"]')];
      if (el.matches('a[href^="/raw/"]')) hits.push(el);
      for (const a of hits) a.setAttribute('href', inScope(a.getAttribute('href')));
    };
    new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) fix(n); })
      .observe(document.documentElement, { childList: true, subtree: true });
  }
})();
