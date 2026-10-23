# token-usage-statusbar

ZCode 桌面端的 Token 用量状态栏插件（参考 [ByteRax/zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar) 的思路做的官方插件形态版本）。

与参考仓库的差异：参考实现是往 Electron 客户端 `app.asar` 注入代码画悬浮条；本插件只用 ZCode 官方插件能力（commands / hooks / MCP），**不改客户端任何文件**。

## 功能

| 能力 | 形态 | 说明 |
| --- | --- | --- |
| `/usage [today\|week\|all\|session <id>]` | 斜杠命令 | 渲染状态栏式用量摘要（输入/输出/思考/缓存、tok/s、TTFT、上下文占比、按模型分解、最近回合表） |
| `/usage on` / `/usage off` | 斜杠命令 | 开关"每轮自动状态栏" |
| 每轮回复后的一行用量摘要 | Stop hook | 开启后每轮回复完自动追加：本轮 token、耗时、tok/s、TTFT、缓存命中率、上下文占比、今日累计。**默认关闭**（每行约 60 token 会进上下文） |
| 会话开始摘要 | SessionStart hook | 开启后显示今日/近 7 天累计与上次活动 |
| `usage_summary` / `recent_turns` | MCP 工具 | 随时可被 Agent 调用的只读查询 |

## 指标口径

- **tok/s** =（输出 token + 思考 token）÷ 模型生成时长（不含工具执行时间），按 `model_usage` 聚合
- **TTFT** = 首 token 延迟（`time_to_first_token_ms`）
- **缓存命中率** = 缓存读 ÷（输入 + 缓存读 + 缓存建）
- **上下文占比** = 最近一次成功请求的（输入+缓存读+缓存建）÷ 上下文窗口（默认 200k，可用环境变量 `ZCODE_CONTEXT_WINDOW` 覆盖）

## 数据来源与隐私

全部数据只读自 ZCode 本地 SQLite：`~/.zcode/cli/db/db.sqlite`（`turn_usage` / `model_usage` / `session` 表），不做任何估算上传，不联网。

## 文件结构

```
token-usage-statusbar/
├── .zcode-plugin/plugin.json   # 清单：commands + hooks + mcpServers
├── commands/usage.md           # /usage 斜杠命令
├── hooks/hooks.json            # Stop / SessionStart 钩子（/usr/bin/python3）
├── hooks/statusline.py         # 钩子脚本：只读查询 + 组装一行摘要
└── mcp/server.mjs              # usage MCP server（零依赖，跑在 ZCode 自带 Node 上）
```

## 依赖与限制

- 钩子用系统 `/usr/bin/python3`（macOS 自带），MCP server 跑在 ZCode 桌面端自带的 Node（`node:sqlite`）上，不需要用户装任何运行时。
- MCP server 的启动命令指向 `/Applications/ZCode.app` 内的 Helper，ZCode 不装在默认位置时需同步修改 `plugin.json`。
- 本地 SQLite 在 ZCode 写入瞬间可能短暂锁库，脚本已做 busy_timeout 与静默容错（查询失败时钩子直接不输出）。

## 开发

- 冒烟测试钩子：`echo '{}' | /usr/bin/python3 hooks/statusline.py stop`（默认关闭应无输出；`touch ~/.zcode/usage-statusbar/enabled` 后输出 `{"additionalContext": ...}`）
- 冒烟测试 MCP：向 `mcp/server.mjs` 的 stdin 逐行发 JSON-RPC（initialize → tools/list → tools/call）
