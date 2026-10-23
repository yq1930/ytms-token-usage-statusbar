#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""Token 用量状态栏钩子（Stop / SessionStart）。

数据只读自 ZCode 本地 SQLite（~/.zcode/cli/db/db.sqlite），不上传。
默认关闭；开启方式：mkdir -p ~/.zcode/usage-statusbar && touch ~/.zcode/usage-statusbar/enabled

输出为 ZCode hook 的严格 JSON：{"additionalContext": "..."}；任何失败都静默退出（exit 0），
避免把错误噪声带进会话。

用法：statusline.py [stop|sessionstart]，hook 的 stdin JSON 会被读取（取 session_id）。
"""
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta

DB_PATH = os.environ.get("ZCODE_DB_PATH") or os.path.expanduser(
    "~/.zcode/cli/db/db.sqlite")
FLAG_PATH = os.environ.get("ZCODE_STATUSBAR_FLAG") or os.path.expanduser(
    "~/.zcode/usage-statusbar/enabled")
try:
    CONTEXT_WINDOW = int(os.environ.get("ZCODE_CONTEXT_WINDOW") or 200000)
except ValueError:
    CONTEXT_WINDOW = 200000


def fmt_tokens(n):
    n = int(n or 0)
    if n >= 1000000:
        s = "%.1fM" % (n / 1000000.0)
        return s.replace(".0M", "M")
    if n >= 1000:
        s = "%.1fk" % (n / 1000.0)
        return s.replace(".0k", "k")
    return str(n)


def fmt_secs(ms):
    if not ms:
        return "-"
    s = ms / 1000.0
    if s < 60:
        return "%.1fs" % s
    return "%dm%02ds" % (s // 60, s % 60)


def since_ms_today():
    midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    return int(midnight.timestamp() * 1000)


def since_ms_week():
    return int((datetime.now() - timedelta(days=7)).timestamp() * 1000)


def open_db():
    try:
        db = sqlite3.connect("file:%s?mode=ro" % DB_PATH, uri=True, timeout=3)
        db.execute("PRAGMA busy_timeout=3000")
        db.execute("SELECT 1")
        return db
    except sqlite3.Error:
        db = sqlite3.connect(DB_PATH, timeout=3)
        db.execute("PRAGMA busy_timeout=3000")
        return db


def cache_hit_rate(tin, cread, ccreate):
    denom = (tin or 0) + (cread or 0) + (ccreate or 0)
    if denom <= 0:
        return None
    return round(100.0 * (cread or 0) / denom)


def latest_completed_turn(db, session_id=None):
    sql = ("SELECT t.session_id, t.turn_id, t.started_at, t.duration_ms, t.time_to_first_token_ms,"
           " t.input_tokens, t.output_tokens, t.reasoning_tokens, t.cache_creation_input_tokens,"
           " t.cache_read_input_tokens, t.model_request_count, t.tool_call_count, s.title"
           " FROM turn_usage t LEFT JOIN session s ON s.id = t.session_id"
           " WHERE t.status='completed'")
    args = []
    if session_id:
        sql += " AND t.session_id = ?"
        args.append(session_id)
    sql += " ORDER BY t.started_at DESC LIMIT 1"
    rows = db.execute(sql, args).fetchall()
    return rows[0] if rows else None


def turn_speed(db, session_id, turn_id):
    """tok/s 取该回合各模型请求的 (输出+思考) 总和 ÷ 生成时长总和，不含工具耗时。"""
    row = db.execute(
        "SELECT COALESCE(SUM(output_tokens+reasoning_tokens),0), COALESCE(SUM(duration_ms),0)"
        " FROM model_usage WHERE session_id=? AND turn_id=? AND status='completed' AND duration_ms>0",
        (session_id, turn_id)).fetchone()
    if not row or not row[1]:
        return None
    return round(row[0] / (row[1] / 1000.0), 1)


def context_status(db, session_id):
    row = db.execute(
        "SELECT input_tokens+cache_read_input_tokens+cache_creation_input_tokens, model_id"
        " FROM model_usage WHERE session_id=? AND status='completed'"
        " ORDER BY started_at DESC LIMIT 1", (session_id,)).fetchall()
    if not row or not row[0][0]:
        return None
    used = row[0][0]
    pct = int(round(100.0 * used / CONTEXT_WINDOW))
    return used, min(pct, 100), row[0][1]


def stop_line(db, session_id):
    t = latest_completed_turn(db, session_id)
    if not t:
        return None
    (sid, turn_id, started_at, dur, ttft, tin, tout, rsn, ccreate, cread,
     reqs, tools, title) = t
    parts = ["⚡ 用量"]
    if title:
        title = title.strip().replace("\n", " ")
        parts.append(("「%s」" % title[:12]) if len(title) > 12 else ("「%s」" % title))
    parts.append("本轮 ↑%s ↓%s" % (fmt_tokens(tin), fmt_tokens(tout)))
    if rsn:
        parts.append("(思%s)" % fmt_tokens(rsn))
    parts.append("· %s" % fmt_secs(dur))
    tps = turn_speed(db, sid, turn_id)
    if tps:
        parts.append("· %.1f tok/s" % tps)
    if ttft:
        parts.append("· TTFT %.1fs" % (ttft / 1000.0))
    hr = cache_hit_rate(tin, cread, ccreate)
    if hr is not None:
        parts.append("· 缓存 %d%%" % hr)
    ctx = context_status(db, sid)
    if ctx:
        used, pct, model = ctx
        parts.append("· 上下文 %d%%（%s/%s）" % (pct, fmt_tokens(used), fmt_tokens(CONTEXT_WINDOW)))
    day = totals(db, since_ms_today())
    parts.append("｜今日 ↑%s ↓%s" % (fmt_tokens(day["input"]), fmt_tokens(day["output"])))
    return " ".join(parts)


def totals(db, since=None):
    sql = ("SELECT COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),"
           " COALESCE(SUM(reasoning_tokens),0), COALESCE(SUM(cache_creation_input_tokens),0),"
           " COALESCE(SUM(cache_read_input_tokens),0), COALESCE(SUM(model_request_count),0)"
           " FROM turn_usage WHERE status='completed'")
    args = []
    if since is not None:
        sql += " AND started_at >= ?"
        args.append(since)
    row = db.execute(sql, args).fetchone()
    return {
        "turns": row[0], "input": row[1], "output": row[2], "reasoning": row[3],
        "cache_creation": row[4], "cache_read": row[5], "requests": row[6],
    }


def last_activity_line(db):
    t = latest_completed_turn(db)
    if not t:
        return None
    sid = t[0]
    started_at = t[2]
    tin, tout = t[5], t[6]
    title = (t[12] or "").strip().replace("\n", " ")
    when = datetime.fromtimestamp(started_at / 1000.0).strftime("%m-%d %H:%M")
    seg = "上次活动 %s" % when
    if title:
        seg += " 「%s」" % (title[:12] if len(title) > 12 else title)
    seg += " ↑%s ↓%s" % (fmt_tokens(tin), fmt_tokens(tout))
    return seg


def start_line(db):
    parts = ["⚡ 状态栏"]
    day = totals(db, since_ms_today())
    parts.append("今日 ↑%s ↓%s（%d 回合）" % (fmt_tokens(day["input"]), fmt_tokens(day["output"]), day["turns"]))
    week = totals(db, since_ms_week())
    parts.append("近7天 ↑%s ↓%s" % (fmt_tokens(week["input"]), fmt_tokens(week["output"])))
    last = last_activity_line(db)
    if last:
        parts.append("｜" + last)
    parts.append("（/usage off 关闭）")
    return " ".join(parts)


def read_session_id():
    try:
        raw = sys.stdin.read()
    except Exception:
        return None
    if not raw or not raw.strip():
        return None
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            sid = data.get("session_id")
            return str(sid) if sid else None
    except Exception:
        pass
    return None


def main():
    if not os.path.exists(FLAG_PATH):
        return 0
    mode = sys.argv[1] if len(sys.argv) > 1 else "stop"
    session_id = None if mode == "sessionstart" else read_session_id()
    try:
        db = open_db()
        try:
            line = start_line(db) if mode == "sessionstart" else stop_line(db, session_id)
        finally:
            db.close()
    except Exception:
        return 0
    if line:
        sys.stdout.write(json.dumps({"additionalContext": line}, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
