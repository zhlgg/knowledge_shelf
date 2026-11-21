"""Runs inside Pyodide (worker.js): reader/server.py itself, over this repo laid out under /kb.

Search and comment writing in the online bookshelf therefore behave exactly as on the Mac. Every function takes and
returns JSON text: {"status", "body", ...}."""
import json
import sys
import types
from pathlib import Path
from urllib.parse import parse_qs

# 网页版的根目录：worker.js 把语料铺在 /kb，shelf_api.py 自己也是 worker.js 从站点上取的（在 Pyodide 里
# 没有 __file__）。KR_SHELF_ROOT 只给本机的检查用（reader/scripts/shelf_corpus_test.py、shelf/build.py 的
# 语料自检）：它们把真实的 shelf_api.py 按同一份语料跑一遍，线上的 globals 里没有这个变量，还是 /kb。
ROOT = Path(globals().get("KR_SHELF_ROOT") or "/kb")

# server.py 在 import 时就要 chat / novel / tts_bridge 三个本地模块，而语料里只有 server.py 自己
# （build.py 的 READER_CORPUS）。这三个都不在网页版的 Python 里跑：
#   · chat        看板娘问答要 Mac 上的 opencode，网页版由 shim.js 自己答 /api/chat
#   · novel       小说区是 build.py 预先算好的加密块（api/novel/*），网页版不读磁盘
#   · tts_bridge  本地朗读服务（novel-shelf 的 Qwen3-TTS）只在 Mac 上，网页版用浏览器自带的朗读
# 所以像 chat 一样先装上替身；真被调用到就明确报错，不给「空结果」骗人（小说区在网页版是有内容的，
# 空结果会被当成「没有书」）。
def _web_only(mod):
    def _raise(*a, **k):
        raise RuntimeError(f"网页版没有「{mod}」这个功能（只在 Mac 上有）")
    return _raise


sys.modules["chat"] = types.ModuleType("chat")     # 看板娘问答 needs opencode on the Mac; shim.js answers /api/chat
_novel = types.ModuleType("novel")
for _fn in ("books", "book_meta", "chapters", "chapter_text"):
    setattr(_novel, _fn, _web_only("小说区"))
sys.modules["novel"] = _novel
_tts = types.ModuleType("tts_bridge")
for _fn in ("health", "voices", "speak"):
    setattr(_tts, _fn, _web_only("本地朗读服务"))
_tts.TtsError = RuntimeError      # server.py 的 except tts_bridge.TtsError 用它
sys.modules["tts_bridge"] = _tts
try:
    import webbrowser  # noqa: F401
except ImportError:
    sys.modules["webbrowser"] = types.ModuleType("webbrowser")
sys.path.insert(0, str(ROOT / "reader"))
sys.argv = ["server.py"]
import server  # noqa: E402

CONFIG = server.load_config()

# 网页版不在这里留 comment_overrides.json 的副本（reader_keep_overrides 的保命副本）。原因：那个文件不在
# 构建的语料名单里（build.py 只带 READER_CORPUS + reader/ 之外的 .md/.json + 目录树里每一节的文件），所以在 MEMFS 里写出来也没法
# 提交回 GitHub，只活到这个标签页关掉为止 —— 与其留一个「看起来存住了其实没存」的副本，不如明确关掉。
# 网页版写的评论同样不会丢：它直接提交到 GitHub，而 macOS 上的 `comment_guard.py export`（跑 annotate_md.py
# 之前的硬规则、也是 wrap 的第一步）会重新扫这些文件把它们收进副本。
server.keep_my_comments = lambda *a, **k: False


def _out(status, body, **extra):
    return json.dumps({"status": status, "body": body, **extra}, ensure_ascii=False)


def _read(rel):
    p = ROOT / rel
    return p.read_bytes().decode("utf-8") if p.is_file() else ""


def search(qs):
    q = parse_qs(qs.lstrip("?"))
    try:
        lim = int(q.get("limit", [server.SEARCH_LIMIT])[0])
    except ValueError:
        lim = server.SEARCH_LIMIT
    views = q.get("views", ["0"])[0] not in ("0", "", "false", "no")
    return _out(200, server.search_docs(ROOT, CONFIG, q.get("q", [""])[0], lim, views, force="refresh" in q))


def comment(req_json):
    """edit_comments() on the in-memory note; the worker commits `after` to GitHub or calls restore(before)."""
    try:
        req = json.loads(req_json)
    except ValueError:
        req = None
    if not isinstance(req, dict):
        return _out(400, {"error": "bad request"})
    hit = server.get_tree(ROOT, CONFIG, force=True)[1].get(str(req.get("section", "")))
    if not hit:
        return _out(404, {"error": "找不到这一节"})
    rel = hit[2]["file"]
    before = _read(rel)
    twin = server.source_twin(ROOT, rel) if req.get("op") == "source" else None
    twin_rel = twin.relative_to(ROOT).as_posix() if twin else None
    twin_before = _read(twin_rel) if twin_rel else None
    try:
        res = server.edit_comments(ROOT, CONFIG, req)
    except server.CommentError as exc:
        return _out(exc.status, {"error": str(exc)})
    extra = {}
    if twin_rel and (res.get("twin") or {}).get("ok"):
        # 改原文 also rewrote the 原稿 / *_views twin: the worker commits it right after the note
        extra = {"twin": twin_rel, "twin_before": twin_before, "twin_after": _read(twin_rel)}
    return _out(200, res, file=rel, before=before, after=_read(rel), **extra)


def restore(rel, text):
    server.write_atomic(ROOT / rel, text)


def reset():
    """After worker.js laid out a newer build under /kb."""
    server.clear_search_cache()


def payloads(rel):
    """The /api/tree answer and every /api/section answer of rel's folder (a 论文版 pairs notes.md with paper.md)."""
    tree, index = server.get_tree(ROOT, CONFIG, force=True)
    folder = Path(rel).parent
    out = {"api/tree": {**tree, "root": "/kb"}}
    for sid, hit in index.items():
        if Path(hit[2]["file"]).parent == folder:
            p = server.section_payload(ROOT, CONFIG, sid)
            if p is not None:
                out["api/section/" + sid] = p
    return json.dumps(out, ensure_ascii=False)
