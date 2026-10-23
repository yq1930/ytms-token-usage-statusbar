// MCP 诊断启动器：桌面端经插件宿主加载本文件。记录实际收到的 argv/env 与
// stdio 流量到 /tmp/ytms-mcp-debug.log，再动态加载同目录 server.mjs 并调用 main()。
// 用于定位“宿主侧 MCP 连接 30s 超时”的真实原因；定位后可移除。
import { appendFileSync } from "node:fs";

const LOG = "/tmp/ytms-mcp-debug.log";
const log = (o) => {
  try {
    appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
  } catch {}
};

log({
  phase: "launch",
  script: process.argv[1] ?? null,
  extraArgs: process.argv.slice(2),
  rootEnv: process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? null,
  cwd: process.cwd(),
  node: process.versions.node,
});

try {
  const mod = await import(new URL("./server.mjs", import.meta.url).href);
  if (typeof mod.main !== "function") {
    log({ phase: "error", error: "server.mjs has no main export" });
    process.exit(1);
  }
  process.stdin.on("data", (d) =>
    log({ phase: "stdin", bytes: d.length, head: d.toString().slice(0, 160) })
  );
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    log({ phase: "stdout", head: String(chunk).slice(0, 160) });
    return origWrite(chunk, ...rest);
  };
  log({ phase: "calling-main" });
  await mod.main();
  log({ phase: "main-returned" });
} catch (e) {
  log({ phase: "error", error: String((e && e.stack) || e).slice(0, 500) });
  process.exit(1);
}
