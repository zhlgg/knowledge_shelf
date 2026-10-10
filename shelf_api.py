"""Runs inside Pyodide (worker.js): reader/server.py itself, over this repo laid out under /kb.

Search and comment writing in the online bookshelf therefore behave exactly as on the Mac. Every function takes and
returns JSON text: {"status", "body", ...}."""
import json
import sys
import types
from pathlib import Path
from urllib.parse import parse_qs

sys.modules["chat"] = types.ModuleType("chat")     # 看板娘问答 needs opencode on the Mac; shim.js answers /api/chat
try:
    import webbrowser  # noqa: F401
except ImportError:
    sys.modules["webbrowser"] = types.ModuleType("webbrowser")
sys.path.insert(0, "/kb/reader")
sys.argv = ["server.py"]
import server  # noqa: E402

ROOT = Path("/kb")
CONFIG = server.load_config()

# 网页版不在这里留 comment_overrides.json 的副本（reader_keep_overrides 的保命副本）。原因：那个文件不在
# 构建的语料名单里（build.py 只带 READER_CORPUS + reader/ 之外的 .md/.json），所以在 MEMFS 里写出来也没法
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
    try:
        res = server.edit_comments(ROOT, CONFIG, req)
    except server.CommentError as exc:
        return _out(exc.status, {"error": str(exc)})
    return _out(200, res, file=rel, before=before, after=_read(rel))


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
