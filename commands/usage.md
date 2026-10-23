---
description: 查询 ZCode Token 用量，渲染状态栏式摘要；on/off 开关每轮自动摘要。
argument-hint: "[today|week|all|session <id>|on|off]"
---

你是 ZCode 用量状态栏插件的处理命令，用户参数为：$ARGUMENTS

按以下规则处理（参数为空时视为 `today`）：

## 参数 on / off（开关每轮自动状态栏）

- `on`：用 Bash 执行 `mkdir -p ~/.zcode/usage-statusbar && touch ~/.zcode/usage-statusbar/enabled`，然后告诉用户：状态栏已开启，从下一轮回复起会自动追加一行用量摘要；用 `/usage off` 可关闭。
- `off`：用 Bash 执行 `rm -f ~/.zcode/usage-statusbar/enabled`，告诉用户已关闭。

## 查询（today / week / all / session）

优先调用本插件的 MCP 工具：

1. 调用 `mcp__usage__usage_summary`，`scope` 取参数值（`today`/`week`/`all`/`session`）；`scope=session` 时需要 session_id，若用户没给，先调 `mcp__usage__recent_turns`（limit 10）列出最近会话让用户选。
2. 再调用 `mcp__usage__recent_turns`（limit 5，session 场景带上选定的 session_id）。

如果 MCP 工具不可用，改用 Bash 直接只读查询本地 SQLite（把 `<SINCE>` 换成本地今日零点/7 天前的 epoch 毫秒；`all` 时删掉 WHERE 里的时间条件）：

```bash
sqlite3 -readonly -json ~/.zcode/cli/db/db.sqlite "SELECT COUNT(*) turns, SUM(model_request_count) requests, SUM(input_tokens) input, SUM(output_tokens) output, SUM(reasoning_tokens) reasoning, SUM(cache_creation_input_tokens) cache_creation, SUM(cache_read_input_tokens) cache_read FROM turn_usage WHERE status='completed' AND started_at >= <SINCE>"
```

以及最近回合：

```bash
sqlite3 -readonly -json ~/.zcode/cli/db/db.sqlite "SELECT datetime(started_at/1000,'unixepoch','localtime') time, s.title, t.duration_ms, t.time_to_first_token_ms ttft, t.input_tokens, t.output_tokens, t.reasoning_tokens FROM turn_usage t LEFT JOIN session s ON s.id=t.session_id WHERE t.status='completed' ORDER BY t.started_at DESC LIMIT 5"
```

## 渲染格式

把结果渲染成下面的"状态栏"摘要（数值用 k/M 压缩；输入 token 含缓存读写一起说明；tok/s = (输出+思考)/生成时长；上下文占比按 200k 窗口估算，MCP 结果里有现成的 `context.used_percent`）：

```
⚡ Token 用量（今日）
↑ 输入 1.2M（缓存命中 87%）  ↓ 输出 45.6k（含思考 3.2k）  ·  平均 18.5 tok/s  ·  TTFT 1.8s
上下文：当前会话 ≈ 90.4k tokens（45% / 200k）
```

然后附一张最近回合明细表：| 时间 | 会话 | 模型 | 耗时 | TTFT | ↑输入 | ↓输出 |，最多 5 行。

数据说明：来自 ZCode 本地 SQLite（`~/.zcode/cli/db/db.sqlite`），只读、不上传。
