// Token 用量状态栏 —— usage MCP server。
// ZCode 插件宿主（__zcode-plugin-host）以 ESM 加载本文件并调用 main()，
// 运行时为 ZCode 桌面端自带的 Node（>=24，内置 node:sqlite），无第三方依赖。
// 数据只读自 ZCode 本地 SQLite（~/.zcode/cli/db/db.sqlite），不上传。

import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const VERSION = "0.1.2";
const DB_PATH =
  process.env.ZCODE_DB_PATH ||
  path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const CONTEXT_WINDOW = Number(process.env.ZCODE_CONTEXT_WINDOW || 200000) || 200000;

const TOOLS = [
  {
    name: "usage_summary",
    description:
      "查询 ZCode 的 Token 用量统计（来自本地 SQLite，只读）。返回输入/输出/思考/缓存 token、缓存命中率、平均输出速度（tok/s）、TTFT、上下文占比和按模型分解。" +
      "scope=today 默认；week 为近 7 天；all 为全部历史；session 需给 session_id。",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["today", "week", "all", "session"],
          default: "today",
          description: "统计范围",
        },
        session_id: {
          type: "string",
          description: "scope=session 时必填的会话 ID",
        },
      },
    },
  },
  {
    name: "recent_turns",
    description:
      "列出最近 N 个已完成回合的用量明细：时间、会话、模型、耗时、TTFT、各 token 计数与输出速度。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 10, maximum: 50, description: "返回条数（默认 10）" },
        session_id: { type: "string", description: "可选，只看某个会话" },
      },
    },
  },
];

function openDb() {
  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    db = new DatabaseSync(DB_PATH);
  }
  db.exec("PRAGMA busy_timeout = 3000");
  return db;
}

function fmtTokens(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function sinceMs(scope) {
  if (scope === "week") return Date.now() - 7 * 24 * 3600 * 1000;
  if (scope === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return null;
}

function totals(db, since, sessionId) {
  let sql =
    "SELECT COUNT(*) AS turns," +
    " COALESCE(SUM(input_tokens),0) AS input_tokens," +
    " COALESCE(SUM(output_tokens),0) AS output_tokens," +
    " COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens," +
    " COALESCE(SUM(cache_creation_input_tokens),0) AS cache_creation_tokens," +
    " COALESCE(SUM(cache_read_input_tokens),0) AS cache_read_tokens," +
    " COALESCE(SUM(model_request_count),0) AS model_requests," +
    " COALESCE(SUM(tool_call_count),0) AS tool_calls," +
    " COALESCE(SUM(tool_error_count),0) AS tool_errors" +
    " FROM turn_usage WHERE status='completed'";
  const args = [];
  if (since != null) {
    sql += " AND started_at >= ?";
    args.push(since);
  }
  if (sessionId) {
    sql += " AND session_id = ?";
    args.push(sessionId);
  }
  // node:sqlite 的 get() 返回具名行对象，不是数组
  const r = db.prepare(sql).get(...args);
  const totalAll =
    r.input_tokens + r.output_tokens + r.reasoning_tokens +
    r.cache_creation_tokens + r.cache_read_tokens;
  return {
    turns: r.turns,
    model_requests: r.model_requests,
    tool_calls: r.tool_calls,
    tool_errors: r.tool_errors,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    reasoning_tokens: r.reasoning_tokens,
    cache_creation_tokens: r.cache_creation_tokens,
    cache_read_tokens: r.cache_read_tokens,
    total_tokens: totalAll,
    cache_hit_rate: totalAll > 0 ? Math.round((100 * r.cache_read_tokens) / totalAll) : null,
  };
}

function speed(db, since, sessionId) {
  let sql =
    "SELECT COALESCE(SUM(output_tokens+reasoning_tokens),0) AS out_tokens," +
    " COALESCE(SUM(duration_ms),0) AS duration_ms," +
    " COALESCE(AVG(time_to_first_token_ms),0) AS avg_ttft," +
    " COUNT(*) AS n FROM model_usage" +
    " WHERE status='completed' AND duration_ms > 0";
  const args = [];
  if (since != null) {
    sql += " AND started_at >= ?";
    args.push(since);
  }
  if (sessionId) {
    sql += " AND session_id = ?";
    args.push(sessionId);
  }
  const r = db.prepare(sql).get(...args);
  return {
    avg_output_tok_per_s:
      r.duration_ms > 0 ? Math.round((r.out_tokens / (r.duration_ms / 1000)) * 10) / 10 : null,
    avg_ttft_ms: r.avg_ttft ? Math.round(r.avg_ttft) : null,
    completed_model_requests: r.n,
  };
}

function byModel(db, since, sessionId) {
  let sql =
    "SELECT provider_id, model_id, COUNT(*) AS requests," +
    " COALESCE(SUM(input_tokens),0) AS input_tokens," +
    " COALESCE(SUM(output_tokens),0) AS output_tokens," +
    " COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens," +
    " COALESCE(SUM(cache_creation_input_tokens),0) AS cache_creation_tokens," +
    " COALESCE(SUM(cache_read_input_tokens),0) AS cache_read_tokens," +
    " COALESCE(SUM(duration_ms),0) AS duration_ms," +
    " COALESCE(AVG(time_to_first_token_ms),0) AS ttft_ms" +
    " FROM model_usage WHERE status='completed'";
  const args = [];
  if (since != null) {
    sql += " AND started_at >= ?";
    args.push(since);
  }
  if (sessionId) {
    sql += " AND session_id = ?";
    args.push(sessionId);
  }
  sql += " GROUP BY provider_id, model_id ORDER BY output_tokens DESC";
  return db.prepare(sql).all(...args).map((r) => ({
    provider_id: r.provider_id,
    model_id: r.model_id,
    requests: r.requests,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    reasoning_tokens: r.reasoning_tokens,
    cache_creation_tokens: r.cache_creation_tokens,
    cache_read_tokens: r.cache_read_tokens,
    output_tok_per_s:
      r.duration_ms > 0
        ? Math.round(((r.output_tokens + r.reasoning_tokens) / (r.duration_ms / 1000)) * 10) / 10
        : null,
    ttft_ms: r.ttft_ms ? Math.round(r.ttft_ms) : null,
  }));
}

function contextStatus(db, sessionId) {
  const args = [];
  let sql =
    "SELECT input_tokens+cache_read_input_tokens+cache_creation_input_tokens AS used, model_id" +
    " FROM model_usage WHERE status='completed'";
  if (sessionId) {
    sql += " AND session_id = ?";
    args.push(sessionId);
  }
  sql += " AND used > 0 ORDER BY started_at DESC LIMIT 1";
  const r = db.prepare(sql).get(...args);
  if (!r) return null;
  return {
    estimated_current_tokens: r.used,
    estimate: fmtTokens(r.used) + " tokens",
    window: CONTEXT_WINDOW,
    used_percent: Math.min(100, Math.round((100 * r.used) / CONTEXT_WINDOW)),
    model_id: r.model_id,
    note: "上下文占比按环境变量 ZCODE_CONTEXT_WINDOW（默认 200k）估算",
  };
}

function usageSummary(db, args) {
  const scope = args?.scope || "today";
  const sessionId = args?.session_id || null;
  if (scope === "session" && !sessionId) {
    return { error: "scope=session 时必须提供 session_id（可先用 recent_turns 查到）" };
  }
  const since = scope === "session" || scope === "all" ? null : sinceMs(scope);
  return {
    scope,
    session_id: sessionId || undefined,
    window_start: since != null ? new Date(since).toISOString() : null,
    totals: totals(db, since, sessionId),
    speed: speed(db, since, sessionId),
    context: contextStatus(db, sessionId),
    by_model: byModel(db, since, sessionId),
  };
}

function recentTurns(db, args) {
  const limit = Math.min(Math.max(Number(args?.limit || 10), 1), 50);
  const sessionId = args?.session_id || null;
  let sql =
    "SELECT t.session_id, t.turn_id, t.started_at, t.duration_ms, t.time_to_first_token_ms," +
    " t.input_tokens, t.output_tokens, t.reasoning_tokens, t.cache_creation_input_tokens," +
    " t.cache_read_input_tokens, t.model_request_count, t.tool_call_count, s.title" +
    " FROM turn_usage t LEFT JOIN session s ON s.id = t.session_id WHERE t.status='completed'";
  const args2 = [];
  if (sessionId) {
    sql += " AND t.session_id = ?";
    args2.push(sessionId);
  }
  sql += " ORDER BY t.started_at DESC LIMIT ?";
  args2.push(limit);
  const turns = db.prepare(sql).all(...args2);
  const domModel = db.prepare(
    "SELECT turn_id, model_id FROM model_usage WHERE turn_id = ? AND status='completed'" +
    " GROUP BY turn_id, model_id ORDER BY COUNT(*) DESC LIMIT 1"
  );
  return {
    turns: turns.map((t) => {
      const m = domModel.get(t.turn_id);
      return {
        session_title: t.title || undefined,
        session_id: t.session_id,
        started_at: new Date(t.started_at).toISOString(),
        model_id: m ? m.model_id : null,
        duration_ms: t.duration_ms,
        ttft_ms: t.time_to_first_token_ms,
        input_tokens: t.input_tokens,
        output_tokens: t.output_tokens,
        reasoning_tokens: t.reasoning_tokens,
        cache_read_tokens: t.cache_read_input_tokens,
        cache_creation_tokens: t.cache_creation_input_tokens,
        model_requests: t.model_request_count,
        tool_calls: t.tool_call_count,
      };
    }),
  };
}

function handleCall(db, params) {
  const name = params?.name;
  const a = params?.arguments || {};
  let result;
  if (name === "usage_summary") result = usageSummary(db, a);
  else if (name === "recent_turns") result = recentTurns(db, a);
  else return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handleMessage(db, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return;
  if (msg.method.startsWith("notifications/")) return;
  switch (msg.method) {
    case "initialize":
      send({
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "ytms-token-usage-statusbar", version: VERSION },
        },
      });
      return;
    case "ping":
      send({ id: msg.id, result: {} });
      return;
    case "tools/list":
      send({ id: msg.id, result: { tools: TOOLS } });
      return;
    case "tools/call":
      try {
        send({ id: msg.id, result: handleCall(db, msg.params) });
      } catch (err) {
        send({
          id: msg.id,
          result: { content: [{ type: "text", text: String(err) }], isError: true },
        });
      }
      return;
    default:
      if (msg.id !== undefined) {
        send({ id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
      }
  }
}

export async function main() {
  const db = openDb();
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handleMessage(db, line);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
