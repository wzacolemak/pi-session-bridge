#!/usr/bin/env node
// claude code Stop hook — 把 bridge 收件箱里排队给本会话的消息"喂回"给 Claude。
// MCP 工具是拉取式; 这个 hook 补上自动送达: Claude 每次回合结束时被本 hook 检查一次
// 收件箱, 有消息则以 exit 2 + stderr 阻止停止并把消息作为反馈注入下一轮。
//
// 安装 (settings.json → hooks):
//   "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//     "command": "node /path/to/pi-session-bridge/deploy/claude-code-bridge-hook.mjs" } ] } ] }
// 身份: <主机名>/cc-<claude_session_id> — 想与 MCP server 共享收件箱, 给两者配置
// 相同的 BRIDGE_AGENT_ID (hook 侧固定值, 不能用含 session_id 的默认值)。
// 配置: 与 MCP server 相同 (BRIDGE_URL 环境变量 / ~/.config/pi-bridge/config.json /
//       ~/.pi/agent/pi-bridge.json)。
// 任何错误都静默退出, 不干扰 Claude 正常停止。
// 注意: 全程不用 process.exit() — Windows/Node24 下 stdin 流活动时强退会触发
// libuv 断言并破坏退出码; 用 exitCode + connection:close 让循环自然排空。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function loadConfig() {
  const out = {};
  for (const p of [
    path.join(os.homedir(), ".config", "pi-bridge", "config.json"),
    path.join(os.homedir(), ".pi", "agent", "pi-bridge.json"),
  ]) {
    try {
      Object.assign(out, JSON.parse(fs.readFileSync(p, "utf8")));
      break;
    } catch {}
  }
  if (process.env.BRIDGE_URL || process.env.PI_BRIDGE_URL) out.bridgeUrl = process.env.BRIDGE_URL || process.env.PI_BRIDGE_URL;
  if (process.env.BRIDGE_TOKEN || process.env.PI_BRIDGE_TOKEN) out.token = process.env.BRIDGE_TOKEN || process.env.PI_BRIDGE_TOKEN;
  return out;
}

const CFG = loadConfig();
const BRIDGE_URL = (CFG.bridgeUrl || "").replace(/\/+$/, "");
const TOKEN = CFG.token || "";
const MACHINE = (os.hostname().split(".")[0] || "unknown").toLowerCase();

async function bridge(p, init) {
  const res = await fetch(BRIDGE_URL + p, {
    ...init,
    headers: {
      connection: "close", // 立即回收 socket, 事件循环可排空
      "content-type": "application/json",
      ...(TOKEN ? { "x-bridge-token": TOKEN } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () =>
  main(raw)
    .then((code) => (process.exitCode = code))
    .catch(() => (process.exitCode = 0)),
);

async function main(raw) {
  let hook = {};
  try {
    hook = JSON.parse(raw);
  } catch {}
  const sessionId = hook.session_id || "";
  if (!sessionId || hook.stop_hook_active || !BRIDGE_URL) return 0;
  const AGENT_ID = process.env.BRIDGE_AGENT_ID || `${MACHINE}/cc-${sessionId}`;

  const reg = await bridge("/register", {
    method: "POST",
    body: JSON.stringify({
      agentId: AGENT_ID,
      machine: MACHINE,
      session: sessionId,
      cwd: hook.cwd || process.cwd(),
      name: "claude-code",
      model: "",
    }),
  }).catch(() => null);
  if (!reg) return 0;

  const inbox = await bridge(`/poll?agent=${encodeURIComponent(AGENT_ID)}`).catch(() => null);
  if (!inbox) return 0;
  const msgs = inbox.messages || [];
  if (!msgs.length) return 0;
  const text = msgs
    .map((m) => `[session-bridge] 来自 ${m.from}（${m.fromMachine}）${m.urgent ? "【urgent】" : ""}：\n${m.message}`)
    .join("\n---\n");
  process.stderr.write(text + "\n");
  return 2; // 阻止停止: stderr 内容作为反馈进入 Claude 下一轮
}
