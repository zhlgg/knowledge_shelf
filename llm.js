/* 看板娘问答 on the online bookshelf — answered by DeepSeek instead of opencode (the Mac runs the librarian agent;
   the Mac may be off, so the web version asks a hosted model instead).

   One POST /api/chat per question, exactly the SSE shape chat.js already speaks (no app.js change):
     {t:'tool', input}   a live 「正在…」 line
     {t:'text',  text}    the answer's FULL text each time it grows (chat.js replaces, never appends)
     {t:'done',  ok, answer, elapsed} | {t:'done', ok:false, error}

   How an answer gets its material: the web's own Pyodide search (server.py's search_docs, same results as the Mac)
   finds sections, then their full source comes from the precomputed /api/section/<id> answers. 严格模式 (the default,
   and the user's choice): before anything leaves the browser the exact text to be sent is shown, and only a click
   sends it. 考考我 · 判卷 sends no note text at all (the message already carries the reader's own answer), so it skips
   the search and the confirmation.

   Two retrieval widths (⚙ 模型 per device, and 「放宽再找一次」 in the confirmation panel for one question):
     宽松 wide (default) —— terms()/queries() cut the question into real words (a space-free Chinese sentence is ONE
       AND-term for search_docs, so the old queries found nothing), up to 8 searches, a bigram sweep if that is still
       thin, 8 sections × 2600 chars, and a prompt that forbids the reflexive 「知识库里没找到」 while still forbidding
       invented citations (general knowledge is allowed but must be labelled). 严格 strict —— the old 4 × 2100.

   Privacy: the conversation lives in this module's memory only — pagehide (close, reload, back, iOS tab switch) wipes
   it, /api/chat/bye wipes it, nothing is written to localStorage or IndexedDB. The API key is kept in *this device's*
   IndexedDB (kr-shelf kv "llm"), never in the published site, so a new device asks for it once. What leaves the browser
   is the confirmed text only; what the provider does with it afterwards is outside this file. */

const KV = 'llm';
// cap = 0 → **不发送 max_tokens**，用服务商自己的默认（DeepSeek：非思考 8K、思考 64K，上限 384K）。
// 之前写死 1600 就是把思考型模型饿死的原因（见 stream() 那段注释），上限交给服务商，我们不猜。
const DEFAULTS = { key: '', model: 'deepseek-v4-pro', base: 'https://api.deepseek.com/v1', auto: false, wide: true,
  cap: 0, think: 'auto' };
// 现在这两个才是 DeepSeek 的模型名（旧的 deepseek-chat / deepseek-reasoner 仍能选，老设备存的也是它们）
const MODELS = [
  ['deepseek-v4-pro', 'deepseek-v4-pro（最强，默认）'],
  ['deepseek-flash', 'deepseek-flash（快、便宜）'],
  ['deepseek-chat', 'deepseek-chat（旧名，仍可用）'],
  ['deepseek-reasoner', 'deepseek-reasoner（旧名，思考型）'],
];
/* 两种检索口径（⚙ 模型 里可以切，确认面板里还能临时放宽一次）：
     宽松 wide   —— 撒 8 次网、最多送 8 篇 × 2600 字、词命中标题额外加分，模型不许一开口就说「没找到」
     严格 strict —— 原来那套：4 篇 × 2100 字，检索不到就老实说没找到
   PLAN 是唯一放数字的地方；excerpt/gather/build 都按它来。 */
const PLAN = {
  wide:   { sections: 8, chars: 2600, queries: 8, per: 6, terms: 6, sweep: 4 },
  strict: { sections: 4, chars: 2100, queries: 4, per: 8, terms: 3, sweep: 0 },
};
const KEEP = 24;           // turns kept in memory (you can ask as many rounds as you like)
const HCHAR = 1200;        // characters of an earlier turn
const HIST = 8;            // how many of them travel with the question
// 上下文是 1M（DeepSeek），所以几轮历史、多长的回答都不该由我们替用户省：下面这两个数只影响花多少钱，不影响能不能问
const TOO_LONG = '> ⚠ 回答到服务端的长度上限被截断了（finish_reason=length）。想让它写完：⚙ 模型 里把「回答长度上限」调大，或换一个更长的模型。';

let ctx = null;            // { call, fetch, base } — the page's search + real fetch, handed over by shim.js
let turns = [];            // in memory only
let warmed = false;
let searchErr = '';        // why retrieval came back empty, so the confirmation can say it out loud
let found = null;          // what the last gather() did: { wide, tried, pool, sent, terms } — the panel shows it
let ui = null;             // the panel (one at a time)

// Line arrays, not one big template literal: these strings talk about backticks and $ signs, and a single stray
// backtick inside a template literal closes it and turns the rest of the prompt into arithmetic (silently).
const COMMON = [
  '你是「知识书架」里的讲解员，正在一个加密的个人 Markdown 知识库的阅读器里和读者聊天。',
  '',
  '你只能看到下面「资料」里给出的笔记片段——它们是知识库搜索功能检索出来的原文。你**看不到整个知识库**，没有工具，也不能联网。引用出处时：',
  '- 讲结论时带上出处，文件路径用反引号包住，路径**原样照抄**资料里给的，不要缩写成 .../xxx，不要写「同上」。',
  '- 第一句就是中文结论本身。不要写「好的」「让我看看」「Here is how」这类开场白，也不要写检索旁白。',
  '- 默认中文。可以用 Markdown：小标题、- 列表、表格、$公式$。',
  '- 长度跟着问题走：一句话的问题就一句话；需要对比多篇时才展开。',
  '- 你的输出会被直接渲染到读者的聊天面板里，所以不要把整段回答包在代码围栏里。',
];

// 严格：资料之外一律不许写。
const STRICT_RULES = [
  '只根据「资料」回答：',
  '- 资料里没有的，就直说「知识库里没找到这部分」，并列出你用到的小节标题；**不要用你自己的先验知识补全，也不要编造**。',
];

// 宽松：资料只是库里的一小块，检索不到 ≠ 库里没有。所以先答，缺口单独说清楚，别拿「没找到」当挡箭牌。
const WIDE_RULES = [
  '「资料」是**搜索出来的若干片段**，只是这个知识库的一小部分，**库里很可能还有相关内容没被检索到**。所以：',
  '- 只要资料沾到问题的一点边，就按资料先回答。**不要因为「没有逐字对应」就回一句「没找到」**，那是最没用的一种回答。',
  '- 资料只覆盖了一部分：先答能答的，最后单独一行写「知识库里没找到：<没覆盖的那部分>」。',
  '- 资料完全没覆盖：**照样回答**，用你自己的通用知识，但要在那段前面单独写一行「（以下不在知识库里，是通用知识）」，并且把资料里确实沾边的内容和出处也列出来。',
  '- 依然不许编造：路径和原文只能从资料里照抄，资料里没有这一条就说「库里没有这一条」；拿不准的地方要明说拿不准。',
];

const RULES = COMMON.concat(STRICT_RULES).join('\n');
const RULES_WIDE = COMMON.concat(WIDE_RULES).join('\n');

const QUIZ = [
  '这条消息是「考考我 · 判卷」。判分规则：',
  '1. 逐条去「资料」里找判分要点：消息里给了题号、题目、读者的回答，以及每条要点的出处（文件路径、小节、一段可以直接搜到的线索原文）。要点本身不在消息里。',
  '2. 拿读者的回答和资料里的原句比：意思答到记 ✔，只答一半或含糊记 ◐，没答到或答错记 ✘。读者用自己的话说、意思对就算 ✔，不要求背原文。',
  '3. 每条要写出原句（用「」括起来）和出处：路径用反引号包住，后面写 § 小节，路径原样照抄。',
  '4. 不许补充新的要点、不许换题。某条线索在资料里真的找不到，就写「这条在原文里没找到」，不要凭印象判。',
  '5. 判定只看 ✘：没有 ✘ 才是「✔ 记住了」，有任何一条 ✘ 就是「↻ 再问一次」。',
  '输出：先一行「**判定：✔ 记住了**」或「**判定：↻ 再问一次**」，然后逐条编号，每条一行「✔/◐/✘ 「原句」 —— 路径 § 小节」加一句点评。不要开场白。',
].join('\n');

/* ------------------------------------------------------------------ config */

async function cfg() {
  const S = await shelf();
  return { ...DEFAULTS, ...((await S.get('kv', KV).catch(() => null)) || {}) };
}
async function saveCfg(o) { await (await shelf()).put('kv', KV, o); }
async function shelf() { if (!self.Shelf) await import(ctx.base + 'crypt.js'); return self.Shelf; }

export function attach(context) {
  ctx = context;
  // the conversation dies with the page: close, reload, back/forward, iOS tab switch
  addEventListener('pagehide', forget, { once: true });
}
export function forget() { turns = []; }

export async function answer(req, send, signal) {
  const q = String((req && req.q) || '').trim();
  if (!q) throw new Error('没有收到问题');
  if (!ctx) throw new Error('问答还没准备好');
  const quiz = /^\s*\[mode: quiz\]/.test(q);
  let c = await cfg();
  if (!c.key) {
    send({ t: 'tool', input: '第一次问答要先填 DeepSeek 的 API key' });
    c = await askKey(c);
    if (!c || !c.key) throw new Error('没有填 API key，这次没有调用模型。');
  }
  let wide = c.wide !== false;                 // per device (⚙ 模型); 「放宽再找一次」 can turn it on for one question
  const blocks = [];
  if (quiz) {
    send({ t: 'tool', input: '判卷：只用你给的答案和出处，不检索笔记' });
  } else {
    const retrieve = async (mode) => {
      send({ t: 'tool', input: warmed
        ? (mode ? '查知识库…（放宽：多撒几次网，多找几篇）' : '查知识库…')
        : '第一次要在浏览器里启动 Python（约 13 MB），请稍等…' });
      warmed = true;
      return gather(q, req.section, mode);
    };
    blocks.push(...await retrieve(wide));
    send({ t: 'tool', input: blocks.length
      ? '找到 ' + blocks.length + ' 篇：' + blocks.map((b) => b.file.split('/').slice(-1)[0].replace(/\.md$/, '')).join('、')
      : (searchErr ? '检索没跑起来：' + searchErr : '这次一个片段都没检索到') });
  }
  let messages = build(q, blocks, quiz, req.where, wide);
  if (!c.auto) {
    for (;;) {
      send({ t: 'tool', input: '等你确认要发送的内容…' });
      const go = await confirm_(messages, blocks, quiz, wide);
      if (go === 'wide') {                     // 「放宽再找一次」: redo the retrieval, then show the panel again
        wide = true;
        blocks.length = 0;
        blocks.push(...await gather(q, req.section, true));
        send({ t: 'tool', input: blocks.length
          ? '放宽后找到 ' + blocks.length + ' 篇：' + blocks.map((b) => b.file.split('/').slice(-1)[0].replace(/\.md$/, '')).join('、')
          : '放宽后还是没检索到片段' });
        messages = build(q, blocks, quiz, req.where, true);
        continue;
      }
      if (go === 'always') { c = { ...c, auto: true, wide }; await saveCfg(c); }
      if (go !== 'yes' && go !== 'always') throw new Error('你取消了这次发送，没有调用模型。');
      break;
    }
  }
  send({ t: 'tool', input: '等模型回答…' });
  const t0 = Date.now();
  const text = await stream(c, messages, send, signal);
  turns.push({ q, a: text });
  if (turns.length > KEEP) turns = turns.slice(-KEEP);
  send({ t: 'done', ok: true, answer: text, elapsed: (Date.now() - t0) / 1000 });
}

/* ------------------------------------------------------------------ retrieval */

/* search_docs()（Mac 和网页版跑的是同一份 server.py）把问题按**空格**切成词，并且要求每个词都以子串形式出现
   somewhere in the section（AND、不分词、不模糊）。一句没空格的中文问题会被当成**一个词**，于是：
     「扩散模型里的 CFG 到底怎么调？和线性插值什么关系」 → terms=[扩散模型里的, cfg, 到底怎么调？和线性插值什么关系] → total 0
   整句、去掉疑问词后的残句、单个空格分隔块，逐个试过去，三个里三个是 0 命中 —— 这就是「搜了也说没找到」的
   真正原因。所以这里自己把问题切成词（英文词 + 中文 2–4 字的组），一个词一次搜索，命中合并后重排。 */
const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf';
const RUN_RE = new RegExp('[' + CJK + ']{2,}', 'g');
// 虚词、疑问词、疑问字：半本笔记都有，捞出来只会把真正讲这题的笔记挤掉（怎/么/什/哪 这几个字单独列出来，
// 否则「底怎」「么调」「什关系」这种碎片会被当成词）
const NOISE = /怎么|如何|为什|为何|什么|是否|能否|可否|区别|不同|讲讲|说说|介绍|聊聊|请问|一下|我们|你们|他们|这个|那个|哪[个些]|关系|影响|原因|意义|作用|方法|问题|东西|以及|还有|怎么|[的了吗呢吧啊哦嗯呀嘛哈呗啦]|是|在|有|就|都|也|很|不|没|要|会|能|把|被|让|给|从|到|用|做|说|想|看|问|你|我|他|她|它|这|那|个|们|[怎么什哪咋]/;
// 三个字以上的片段如果**首尾**是这些字，那它一定是被切碎的半个词（和线性插、扩散模型里、视频生成上…），不是词。
// 方位/体词的首字（里上中下内间外）也在列：它们几乎只出现在切碎的片段里；前/后 不在列（前向传播、后向传播 是真词）。
const EDGE = /[的了吗呢吧啊哦嗯呀嘛哈呗啦是就在都很不没要会能想把被让给从到用做说看你们他她它这那个们和与跟及里上中下内间外]/;
// 整句里剥掉这些词，得到一个「更干净」的整句查询（老 queries() 的第二种查法）
const STOP = /怎么|如何|为什么|是什么|为什么|区别|讲讲|介绍|能不能|可不可以|可以吗|是否|一下|请问|帮我|我们|这个|那个|哪个|\?|？|。|，|,|的|了|吗|呢/g;

/* 问题的词：英文/数字先来（最具体），中文按 4→2 字贪心取**互不重叠**的片段，滤掉含虚词的。
   一个词在 4 格里就整段吃掉，短词不会再被单独查一遍（那只会拉回一堆泛泛的笔记）。 */
function terms(q, cap) {
  const text = String(q || '');
  const out = [];
  const push = (t) => {
    t = String(t || '').trim();
    if (t.length < 2 || t.length > 24) return;
    if (out.some((x) => x.includes(t))) return;              // 已经被一个更长的词盖住
    for (let i = out.length - 1; i >= 0; i--) if (t.includes(out[i])) out.splice(i, 1);
    out.push(t);
  };
  for (const w of text.match(/[A-Za-z][A-Za-z0-9._+-]*|\d+(?:\.\d+)?/g) || []) if (w.length > 1) push(w);
  for (const w of text.split(/[\s,，。？?！!、；;：:（）()「」『』“”"'§\x60-]+/)) {
    if (w.length > 1 && /^[\x20-\x7e]+$/.test(w)) push(w);     // 被标点切开的英文词（3D、VAE…）
  }
  // 汉字串切成 2–5 字的候选片段，按「像不像一个完整的词」排序（左右邻居 + 长度），再贪心取互不重叠的
  const runs = [...text.matchAll(RUN_RE)];
  const cands = [];
  runs.forEach((m, ri) => {
    const run = m[0];
    for (let n = Math.min(5, run.length); n >= 2; n--) {
      for (let i = 0; i + n <= run.length; i++) {
        const L = i > 0 ? run[i - 1] : text[m.index - 1];
        const R = i + n < run.length ? run[i + n] : text[m.index + run.length];
        cands.push({ t: run.slice(i, i + n), ri, from: i, to: i + n, n, conf: bound(L) + bound(R) });
      }
    }
  });
  cands.sort((a, b) => b.conf - a.conf || b.n - a.n || a.ri - b.ri || a.from - b.from);
  const taken = [];
  const free = (c) => !taken.some((p) => p.ri === c.ri && c.from < p.to && p.from < c.to);
  const scan = (filtered, max) => {
    // 不滤虚词的那一遍从短的开始：两个字的碎片至少还可能是个词，三字的多半是被切开的半个词
    const list = filtered ? cands : cands.slice().sort((a, b) => a.n - b.n || b.conf - a.conf);
    for (const c of list) {
      if (out.length >= max) break;
      if (!free(c) || out.some((x) => x.includes(c.t) || c.t.includes(x))) continue;
      if (!filtered && c.conf < 1) continue;
      if (filtered && (c.conf < 1 || NOISE.test(c.t) || (c.n >= 3 && (EDGE.test(c.t[0]) || EDGE.test(c.t[c.t.length - 1]))))) continue;
      taken.push(c);
      push(c.t);
    }
  };
  scan(true, cap);
  // 上面这一遍还要求 conf ≥ 1：左右都是内容字的片段（频生成 ← 视频生成、模型和渐）几乎一定是半个词，
  // 它们只会在一个干净词都没切出来时（scan(false)）才被捡起来。
  if (!out.length) scan(false, 2);
  return out;
}

// 兜底撒网用的 2 字词：问题里每两个相邻的汉字，不管有没有虚词（terms() 挑剩下的那些）。查过的跳过。
function bigrams(q, cap, skip) {
  const out = [], done = (skip || []).map((s) => String(s).toLowerCase());
  for (const run of String(q || '').match(RUN_RE) || []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const g = run.slice(i, i + 2);
      if (out.length >= cap) return out;
      if (out.includes(g) || done.includes(g.toLowerCase())) continue;
      out.push(g);
    }
  }
  return out;
}

// 词边界：左右邻居是虚词/标点/英文，这个片段就很可能正好是一个词；左右都是内容字，它多半是被切开的半个词
//（频生成 ← 视频生成，值关系 ← 插值什么关系）。片段本身没有左/右邻居时按 0.5 算：问题开头结尾也能是词。
const BOUND = /[\s,.，。？！、；：:!?（）()「」『』"'\x60和与跟或但而且并则若如按据由往朝沿此该另过的了吗呢吧啊哦嗯呀嘛哈呗啦是为在就都很不没要会能把被让给从到用做说想看讲谈聊问答你们他她它这那个们里上中下内间外]/;
const bound = (ch) => (ch === undefined || ch === '' ? 0.5 : BOUND.test(ch) ? 1 : 0);

/* 一个中文问题要查好几次：整句、去掉疑问词的整句、每个词单独查（= 任一命中即可，这就是「宽」）、
   最后把最长的两个词并起来查一次（= 全中，最准，放最后兜底）。strict 还是老的口径。 */
function queries(q, wide = true) {
  const plan = wide ? PLAN.wide : PLAN.strict;
  const out = [];
  const add = (s) => {
    s = String(s || '').trim();
    if (s && s.length <= 60 && !out.includes(s) && out.length < plan.queries) out.push(s);
  };
  add(q);
  add(String(q || '').replace(STOP, ' ').replace(/\s+/g, ' ').trim());
  const words = String(q || '').split(/\s+/).filter((w) => w.length > 1);
  const ts = wide ? terms(q, plan.terms) : words;
  for (const t of ts.slice(0, wide ? 6 : 3)) add(t);
  if (ts.length > 1) add(ts.slice().sort((a, b) => b.length - a.length).slice(0, 2).join(' '));
  return out;
}

async function sectionBody(id) {
  if (!id) return null;
  const res = await ctx.fetch('/api/section?id=' + encodeURIComponent(id), { cache: 'no-cache' }).catch(() => null);
  if (!res || !res.ok) return null;
  const b = await res.json().catch(() => null);
  if (!b || typeof b.markdown !== 'string' || !b.markdown.trim()) return null;
  return b;
}

// a window of the section around its best-matching line, always keeping the head so the model knows what it is.
// terms must be real words (terms()), not the raw question: a space-free Chinese question used to match nothing here,
// so the model only ever saw the head of the section.
function excerpt(markdown, terms, chars = PLAN.wide.chars) {
  const lines = markdown.split('\n');
  const head = lines.slice(0, 6).join('\n');
  let best = -1, score = 0;
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    let s = 0;
    for (const t of terms) if (t && low.includes(t.toLowerCase())) s += t.length >= 3 ? 2 : 1;
    if (s > score) { score = s; best = i; }
  }
  if (best < 0 || lines.join('\n').length <= chars) return markdown.slice(0, chars);
  let from = Math.max(0, best - 6), n = 0, out = [];
  for (let i = from; i < lines.length && n < chars; i++) { out.push(lines[i]); n += lines[i].length + 1; }
  const text = (from > 0 ? head + '\n\n…\n\n' : '') + out.join('\n');
  return text.slice(0, chars + head.length + 8);
}

// search_docs ranks by tier then hit count, which is right inside one query; across the fallback queries a body-only
// mention can beat a section that is actually *about* the question, so re-rank: a word (CFG, 线性插值, SFT…) in the
// title, heading or path is worth much more than one more hit somewhere in the text. Two-character words are so common
// that a title hit is worth less, and a section several different queries found is worth a nudge (that is what an OR
// would do).
function weight(t) { return t.length >= 4 ? 3.5 : t.length === 3 ? 3 : 1.6; }
function score(hit, ts) {
  let s = Math.min(hit.count || 0, 8) * 0.2;
  if (!ts || !ts.length) return s;
  const title = ((hit.title || '') + ' ' + (hit.heading || '')).toLowerCase();
  const file = (hit.file || '').toLowerCase();
  for (const t of ts) {
    if (!t || t.length < 2) continue;
    if (title.includes(t.toLowerCase())) s += weight(t);
    if (file.includes(t.toLowerCase())) s += weight(t) * 0.7;
  }
  return s;
}

async function gather(q, sectionId, wide) {
  const plan = wide ? PLAN.wide : PLAN.strict;
  const blocks = [], seen = new Set(), pool = new Map(), tried = [];
  searchErr = '';
  const ts = terms(q, plan.terms);
  const take = async (id, label) => {
    if (!id || seen.has(id) || blocks.length >= plan.sections) return;
    const b = await sectionBody(id);
    if (!b) return;
    seen.add(id);
    blocks.push({ id, file: b.file, heading: b.heading, title: b.title, topic: b.topic && b.topic.title,
      chapter: b.chapter && b.chapter.title, label, text: excerpt(b.markdown, ts.length ? ts : [q], plan.chars) });
  };
  await take(sectionId, '你正在看的这一节');           // the Mac's librarian reads the current document first
  const ask = async (query) => {
    if (!query) return;
    tried.push(query);
    let r = null;
    try { r = await ctx.call('search', { qs: '?q=' + encodeURIComponent(query) + '&limit=' + plan.per }); }
    catch (err) { searchErr = searchErr || (err.message || String(err)); return; }
    if (r && r.status >= 500) searchErr = searchErr || ((r.body && r.body.error) || ('搜索返回 ' + r.status));
    for (const hit of (r && r.body && r.body.results) || []) {
      if (!hit || !hit.sectionId || seen.has(hit.sectionId)) continue;
      const s = score(hit, ts), cur = pool.get(hit.sectionId);
      if (cur) cur.s = Math.max(cur.s, s) + 1.2;        // several queries found it ⇒ it is about the question
      else pool.set(hit.sectionId, { hit, s });
    }
  };
  for (const query of queries(q, wide)) await ask(query);
  if (plan.sweep && pool.size + blocks.length < plan.sections) {
    for (const g of bigrams(q, plan.sweep, tried)) await ask(g);   // still thin: cast the net wider
  }
  for (const { hit } of [...pool.values()].sort((a, b) => b.s - a.s)) {
    if (blocks.length >= plan.sections) break;
    await take(hit.sectionId, '检索到的');
  }
  found = { wide, tried, pool: pool.size, sent: blocks.length, terms: ts, chars: plan.chars, cap: plan.sections };
  if (sectionId && !blocks.length && !searchErr) searchErr = '这一节的正文没取到';
  return blocks;
}

/* ------------------------------------------------------------------ prompt */

// 「`path` § 小节」 — one place, so a heading that already starts with § does not double up
function cite(b) {
  const h = String(b.heading || b.title || '').replace(/^§\s*/, '').trim();
  return '`' + b.file + '`' + (h ? ' § ' + h : '');
}

function build(q, blocks, quiz, where, wide = true) {
  // 判卷永远用严格的规则：判卷要拿笔记原文当依据，「资料没覆盖就用通用知识补」那条只对问答开放
  const sys = [wide && !quiz ? RULES_WIDE : RULES, quiz ? QUIZ : ''].filter(Boolean).join('\n\n');
  const out = [{ role: 'system', content: sys }];
  if (!quiz) {
    if (where) out.push({ role: 'user', content: `（读者当前在这一节：${where}）` });
    if (blocks.length) {
      out.push({ role: 'user', content: '以下是知识库检索到的笔记片段：\n\n'
        + blocks.map((b, i) => `【资料 ${i + 1}】${cite(b)}\n${b.text}`).join('\n\n---\n\n') });
    } else {
      out.push({ role: 'user', content: wide
        ? '（这次一个片段都没检索到。按规则：仍然回答，用你自己的通用知识，并在那一段前面写「（以下不在知识库里，是通用知识）」。）'
        : '（这次没有检索到相关片段。只根据读者的问题和你自己的理解回答，并说明知识库里没有找到依据。）' });
    }
    for (const t of turns.slice(-HIST)) {
      out.push({ role: 'user', content: t.q.slice(0, HCHAR) });
      out.push({ role: 'assistant', content: t.a.slice(0, HCHAR) });
    }
  }
  out.push({ role: 'user', content: q });
  return out;
}

/* ------------------------------------------------------------------ the model call */

/* 请求体。**不写 max_tokens**（用户 2026-10-07：「你应该让它返回更多才对，不给它设置限制」）：OpenAI 兼容的接口
   都把 max_tokens 当可选，DeepSeek 省略时用「非思考 8K / 思考 64K」的自定义值（硬上限 384K，上下文 1M），
   比我们替用户猜一个数字靠谱 —— 之前写死 1600，正是把 deepseek-reasoner 饿死的原因：它先把 max_tokens 全花在
   reasoning_content 上，正文一个字轮不到（finish_reason=length，content 为空），页面只看到「模型没有返回内容」。
   想知道确切上限就在 ⚙ 里填，那时才发 max_tokens。thinking 现在是 DeepSeek 的**默认模式**，所以也给一个开关。 */
function requestBody(c, messages) {
  const b = { model: c.model, messages, stream: true, stream_options: { include_usage: true }, temperature: 0.3 };
  const cap = Math.floor(Number(c.cap) || 0);
  if (cap > 0) b.max_tokens = Math.min(393216, cap);
  if (c.think === 'on' || c.think === 'off') b.thinking = { type: c.think === 'on' ? 'enabled' : 'disabled' };
  return b;
}

async function stream(c, messages, send, signal) {
  const res = await ctx.fetch(c.base.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
    body: JSON.stringify(requestBody(c, messages)),
    signal,
  }).catch((err) => { throw new Error('连不上 ' + c.base + '：' + (err.message || err)); });
  if (!res.ok || !res.body) throw new Error(await why(res));
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', acc = '', think = '', last = 0, said = 0, usage = null, finish = '';
  const push = (force) => {
    const now = Date.now();
    if (!force && now - last < 50) return;
    last = now;
    send({ t: 'text', text: acc });
  };
  // 只思考不出声时，回答框会一直是空的，看着像卡死；把「还在想」报到状态栏上
  const thinking = () => {
    const now = Date.now();
    if (now - said < 700) return;
    said = now;
    send({ t: 'tool', input: '模型正在思考…（已经想了 ' + think.length + ' 字）' });
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(raw); } catch (_) { continue; }
        if (ev.error) throw new Error(ev.error.message || String(ev.error));
        if (ev.usage) usage = ev.usage;
        const ch = (ev.choices && ev.choices[0]) || {};
        if (ch.finish_reason) finish = ch.finish_reason;
        const d = ch.delta || {};
        if (typeof d.reasoning_content === 'string' && d.reasoning_content) { think += d.reasoning_content; if (!acc) thinking(); }
        if (typeof d.content === 'string' && d.content) { acc += d.content; push(false); }
      }
    }
  }
  push(true);
  if (!acc.trim()) throw new Error(whyEmpty(c, think, usage, finish));
  // 被截断、被过滤、中断 —— 都要说出来，别让一段半截的回答看起来像是完整的
  if (finish === 'length') acc += '\n\n' + TOO_LONG;
  else if (finish === 'content_filter') acc += '\n\n> ⚠ 这段回答被服务端的内容过滤截掉了。';
  else if (finish === 'aborted' || finish === 'insufficient_system_resource') acc += '\n\n> ⚠ 回答被服务端中断了（' + finish + '），可以再问一次。';
  return acc;
}

// 一次都没吐正文：把能拿到的线索都写进这句报错里，别再只给一个「没有返回内容」
function whyEmpty(c, think, usage, finish) {
  const r = usage && (usage.completion_tokens_details || {}).reasoning_tokens;
  const bits = [];
  if (usage) bits.push('这次共 ' + usage.total_tokens + ' tokens（提示 ' + (usage.prompt_tokens || '?')
    + '，生成 ' + (usage.completion_tokens || 0) + (r ? '，其中思考 ' + r : '') + '）');
  if (finish) bits.push('finish_reason=' + finish);
  if (think) bits.push('模型只返回了 ' + think.length + ' 字的思考过程，没有正式回答');
  let why = '模型没有返回正文';
  if (think && finish === 'length') {
    why += '（思考过程把长度上限用光了；在 ⚙ 模型 里把「思考」关掉，或者把「回答长度上限」调大）';
  } else if (usage && usage.completion_tokens === 0 && !think) {
    why += '（一个字都没生成：把检索口径调回严格模式试试，或者换个模型）';
  } else if (think) {
    why += '（只返回了思考过程；在 ⚙ 模型 里把「思考」关掉）';
  }
  return why + (bits.length ? '（' + bits.join('，') + '）' : '');
}

async function why(res) {
  let msg = '';
  try { const j = await res.json(); msg = (j.error && (j.error.message || j.error.type)) || j.message || ''; } catch (_) { /* not json */ }
  if (res.status === 401 || res.status === 403) return 'API key 不对或者没权限（点左栏 ⚙ 模型 换一个）' + (msg ? '：' + msg : '');
  if (res.status === 402) return '账户余额不足（DeepSeek 官方是按量付费的）' + (msg ? '：' + msg : '');
  if (res.status === 429) return '请求太频繁或者额度用完了，等一会儿再试' + (msg ? '：' + msg : '');
  return '模型服务返回 ' + res.status + (msg ? '：' + msg : '');
}

/* ------------------------------------------------------------------ panels (one shared shell) */

const CSS = `
.kr-llm { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; background: rgba(30,20,30,.45);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.kr-llm[hidden] { display: none; }
.kr-llm-box { width: min(94vw, 720px); max-height: 88vh; display: flex; flex-direction: column; background: var(--paper);
  color: var(--ink); border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow); overflow: hidden;
  font-family: var(--sans); font-size: 13.5px; line-height: 1.7; }
.kr-llm-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px;
  border-bottom: 1px dashed var(--line); font-size: 15px; }
.kr-llm-x { border: 0; background: transparent; color: var(--ink-3); font-size: 16px; cursor: pointer; }
.kr-llm-body { padding: 12px 18px; overflow: auto; color: var(--ink-2); }
.kr-llm-body p { margin: 0 0 8px; }
.kr-llm-body b { color: var(--ink); }
.kr-llm-body code, .kr-llm-body .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.kr-llm details { border: 1px solid var(--line); border-radius: 10px; padding: 6px 10px; margin: 6px 0; }
.kr-llm summary { cursor: pointer; color: var(--ink); }
.kr-llm pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0 2px; max-height: 320px; overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--ink-2); }
.kr-llm label { display: block; margin: 8px 0 2px; color: var(--ink); }
.kr-llm input[type=password], .kr-llm input[type=text], .kr-llm select { width: 100%; box-sizing: border-box; font: inherit;
  padding: 7px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--paper-2); color: var(--ink); }
.kr-llm-foot { display: flex; gap: 8px; justify-content: flex-end; align-items: center; padding: 10px 18px 14px; }
.kr-llm-foot button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--line); background: transparent;
  color: var(--ink-2); font: inherit; cursor: pointer; }
.kr-llm-foot .go { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.kr-llm-foot .warn { color: var(--ink-3); margin-right: auto; font-size: 12.5px; }
.kr-llm-foot button:disabled { opacity: .5; cursor: default; }
`;

function el(tag, text) { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; }

function shell(title) {
  if (!ui) {
    document.head.appendChild(el('style', CSS));
    const box = el('div');
    box.className = 'kr-llm';
    box.hidden = true;
    box.innerHTML = `<div class="kr-llm-box" role="dialog" aria-modal="true">
      <div class="kr-llm-head"><b></b><button class="kr-llm-x" aria-label="关闭">✕</button></div>
      <div class="kr-llm-body"></div>
      <div class="kr-llm-foot"></div>
    </div>`;
    document.body.appendChild(box);
    const body = box.querySelector('.kr-llm-body');
    const foot = box.querySelector('.kr-llm-foot');
    ui = { box, head: box.querySelector('.kr-llm-head b'), body, foot };
    box.querySelector('.kr-llm-x').addEventListener('click', () => settle(null));
    box.addEventListener('click', (e) => { if (e.target === box) settle(null); });
    window.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { e.preventDefault(); settle(null); }
    }, true);
  }
  ui.head.textContent = title;
  return ui;
}

let resolve = null;
// close the panel and hand the caller's promise its value (null = the user closed it)
function settle(value) {
  if (ui) ui.box.hidden = true;
  const r = resolve;
  resolve = null;
  if (r) r(value);
}
function block(label, text, open) {
  const d = el('details');
  d.open = !!open;
  d.append(el('summary', label), el('pre', text));
  return d;
}

// Strict mode: show the exact messages, then send only on a click
function confirm_(messages, blocks, quiz, wide) {
  const u = shell('发送给模型的内容');
  u.body.replaceChildren();
  if (quiz) {
    u.body.append(el('p', '判卷模式：不检索知识库、不发送任何笔记原文，只发送下面这条消息（你自己的作答和题目给的线索）。'));
  } else {
    const lead = el('p');
    lead.append(el('b', '下面是这次要发给 DeepSeek 的全部内容。'),
      '你的笔记里有未公开的内部内容（团队代号、规划、内部文档名），所以默认逐次确认。');
    u.body.append(lead);
    if (found) {
      const p = el('p');
      p.append(el('b', '检索：' + (wide ? '宽松' : '严格') + '，'
        + '查了 ' + found.tried.length + ' 次（' + (found.terms.length ? found.terms.join('、') : '没有切出关键词')
        + '），命中 ' + found.pool + ' 篇，送出 ' + found.sent + ' 篇 × 最多 ' + found.chars + ' 字。'));
      u.body.append(p);
    }
    if (searchErr) u.body.append(el('p', '⚠ 知识库检索没能跑起来：' + searchErr + ' 这次只发送你的问题和角色说明（Mac 上的书架不受影响）。'));
    if (!blocks.length && !searchErr) u.body.append(el('p', '这次没有检索到相关笔记。'
      + (wide ? '宽松模式下模型会用自己的通用知识回答，并标明「（以下不在知识库里，是通用知识）」。'
             : '可以点下面的「放宽再找一次」多撒几遍网。')));
  }
  for (const m of messages) {
    const who = m.role === 'system' ? '角色说明与规则'
      : m.role === 'assistant' ? '之前的回答（截断）'
      : /^\（读者当前在这一节/.test(m.content) ? '你正在看的章节'
      : /^（/.test(m.content) ? '检索说明'
      : '你的提问';
    u.body.append(block(who, m.content, m.role === 'user' && who === '你的提问'));
  }
  if (blocks.length) {
    const d = el('details');
    d.append(el('summary', `涉及 ${blocks.length} 篇笔记：${blocks.map((b) => b.file.split('/').slice(-1)[0]).join('、')}`));
    for (const b of blocks) d.append(block(cite(b), b.text, false));
    u.body.append(d);
  }
  const note = el('span', '网页版只能看到检索到的片段；Mac 上她能翻遍全库。');
  note.className = 'warn';
  u.foot.replaceChildren(note);
  return new Promise((res) => {
    resolve = res;
    const always = el('input');
    always.type = 'checkbox';
    const lab = el('label', ' 这个设备以后直接发送（仍只发这些片段）');
    lab.style.margin = '0';
    lab.prepend(always);
    u.foot.prepend(lab);
    const no = el('button', '这次不发');
    const yes = el('button', '发送给模型');
    yes.className = 'go';
    if (wide) { u.foot.append(no, yes); }
    else {
      const wideBtn = el('button', '放宽再找一次');
      wideBtn.title = '多撒几遍网、最多送 ' + PLAN.wide.sections + ' 篇 × ' + PLAN.wide.chars + ' 字，这次用宽松口径';
      u.foot.append(wideBtn, no, yes);
      wideBtn.onclick = () => settle('wide');
    }
    no.onclick = () => settle('no');
    yes.onclick = () => settle(always.checked ? 'always' : 'yes');
    ui.box.hidden = false;
  });
}

// The key, the model, and whether to keep confirming — all in this device's IndexedDB, never in the site
function settingsPanel() {
  const u = shell('看板娘问答 · 模型设置');
  return cfg().then((c) => {
    u.body.replaceChildren();
    u.body.append(el('p', '网页版的看板娘不调 opencode，改调 DeepSeek 官方 API。key 只存在这台设备的浏览器里，不进网站、不进仓库；换设备要重填一次。'));
    const key = el('input');
    key.type = 'password';
    key.placeholder = 'sk-…（DeepSeek 开放平台 → API keys）';
    key.value = c.key;
    const show = el('input');
    show.type = 'checkbox';
    const showLab = el('label', ' 显示');
    showLab.style.margin = '0 0 6px';
    showLab.prepend(show);
    show.onchange = () => { key.type = show.checked ? 'text' : 'password'; };
    const model = el('select');
    const names = MODELS.map((m) => m[0]);
    for (const [v, t] of (names.includes(c.model) ? MODELS : MODELS.concat([[c.model, c.model + '（你之前选的）']]))) {
      const o = el('option', t);
      o.value = v;
      if (c.model === v) o.selected = true;
      model.append(o);
    }
    const base = el('input');
    base.type = 'text';
    base.value = c.base;
    const cap = el('input');
    cap.type = 'number';
    cap.min = '0';
    cap.step = '1024';
    cap.placeholder = '0 = 不限制';
    cap.value = c.cap || 0;
    const think = el('select');
    for (const [v, t] of [['auto', '听服务商的（DeepSeek 现在默认会先想）'], ['off', '关掉思考（更快更便宜）'], ['on', '一定要先想']]) {
      const o = el('option', t);
      o.value = v;
      if ((c.think || 'auto') === v) o.selected = true;
      think.append(o);
    }
    const auto = el('input');
    auto.type = 'checkbox';
    auto.checked = !!c.auto;
    const wide = el('input');
    wide.type = 'checkbox';
    wide.checked = c.wide !== false;
    u.body.append(el('label', 'API key'), key, showLab, el('label', '模型'), model, el('label', '接口地址'), base,
      el('label', '回答长度上限（tokens，0 = 不限制，用服务商默认；DeepSeek 非思考 8K、思考 64K）'), cap,
      el('label', '思考模式（只有 DeepSeek 官方接口认这个参数）'), think);
    const wideLab = el('label', ' 宽松检索：多撒几遍网、最多送 ' + PLAN.wide.sections + ' 篇 × ' + PLAN.wide.chars
      + ' 字，并且不轻易说「知识库里没找到」（关掉就是严格模式：' + PLAN.strict.sections + ' 篇 × ' + PLAN.strict.chars + ' 字）');
    wideLab.prepend(wide);
    wideLab.style.marginTop = '8px';
    u.body.append(wideLab);
    const autoLab = el('label', ' 以后不再逐次确认发送内容（严格模式是默认的；打开后仍然只发检索到的片段）');
    autoLab.prepend(auto);
    autoLab.style.marginTop = '8px';
    u.body.append(autoLab);
    u.foot.replaceChildren();
    const hint = el('span', '');
    hint.className = 'warn';
    u.foot.append(hint);
    const forget = el('button', '清除 key');
    const test = el('button', '测试连接');
    const save = el('button', '保存');
    save.className = 'go';
    u.foot.append(forget, test, save);
    u.box.hidden = false;
    return new Promise((res) => {
      resolve = res;
      const done = async () => {
        const next = { ...c, key: key.value.trim(), model: model.value, base: base.value.trim(),
          cap: Math.max(0, Math.floor(Number(cap.value) || 0)), think: think.value,
          auto: auto.checked, wide: wide.checked };
        await saveCfg(next).catch((err) => { hint.textContent = '没能存下来：' + (err.message || err); });
        settle(next);
      };
      save.onclick = done;
      forget.onclick = async () => {
        const blank = { ...DEFAULTS, auto: auto.checked, wide: wide.checked, cap: Number(cap.value) || 0, think: think.value };
        await saveCfg(blank);
        settle(blank);
      };
      test.onclick = async () => {
        hint.textContent = '测试中…';
        try {
          const r = await ctx.fetch(base.value.replace(/\/+$/, '') + '/models',
            { headers: { Authorization: 'Bearer ' + key.value.trim() } });
          hint.textContent = r.ok ? '连接正常，这个 key 可以用' : 'HTTP ' + r.status + '：key 可能不对';
        } catch (e) {
          hint.textContent = '连不上：' + (e.message || e);
        }
      };
      ui.box.hidden = false;
    });
  });
}

function askKey(c) {
  return settingsPanel().then((next) => (next && next.key ? next : null));
}

/** The ⚙ button in the sidebar row (shim.js injects it next to 「更新到本地文件夹」). */
export function openSettings() { return settingsPanel(); }
