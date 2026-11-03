#!/usr/bin/env node
// claude code Stop hook — 把 bridge 收件箱里排队给本会话的消息"喂回"给 Claude。
// MCP 工具是拉取式; 这个 hook 补上自动送达: 每次回合结束时查一次收件箱,
// 有消息则以 exit 2 + stderr 阻止停止, 消息作为反馈注入下一轮。
//
// 覆盖范围: Stop hook 只在回合结束时触发。Claude 完全空闲(等人输入)时到来的
// 消息不会立刻唤醒它, 而是排队到下一次交互的回合末送达; 身份由 MCP server 的
// 20s 心跳持续保活, 空闲会话在 session_list 里仍然可见、可发、可排队。
//
// 安装 (settings.json → hooks):
//   "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//     "command": "node /path/to/pi-session-bridge/deploy/claude-code-bridge-hook.mjs",
//     "timeout": 15 } ] } ] }
// 身份: 与 MCP server 相同的 <主机名>/cc-<锚定进程pid> — 两边沿父进程链跳过 shell
// 包装层后独立算出同一 pid, 天然共享收件箱, 无需手工对齐 (BRIDGE_AGENT_ID 可固定)。
// 配置: 与 MCP server 相同 (BRIDGE_URL 环境变量 / ~/.config/pi-bridge/config.json /
//       ~/.pi/agent/pi-bridge.json)。
// 任何错误都静默退出, 不干扰 Claude 正常停止。
// 注意: 全程不用 process.exit() — Windows/Node24 下 stdin 流活动时强退会触发
// libuv 断言并破坏退出码; 用 exitCode + connection:close 让循环自然排空。
import child_process from "node:child_process";
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

// --- 与 mcp/server.mjs 保持一致的锚定逻辑 ---
const SHELL_RE = /^(sh|bash|dash|zsh|fish|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe)$/;
function procInfo(pid) {
  try {
    if (process.platform === "win32") {
      const out = child_process.execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\") | Select-Object Name,ParentProcessId | ConvertTo-Json -Compress"`,
        { encoding: "utf8", timeout: 8000, windowsHide: true },
      ).trim();
      const j = JSON.parse(out || "{}");
      return { name: String(j.Name || "").toLowerCase(), ppid: Number(j.ParentProcessId || 0) };
    }
    const name = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim().toLowerCase();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return { name, ppid };
  } catch {
    return null;
  }
}
function anchorPid() {
  let pid = process.ppid;
  for (let i = 0; i < 3; i++) {
    const info = procInfo(pid);
    if (!info || !SHELL_RE.test(info.name) || !info.ppid) break;
    pid = info.ppid;
  }
  return pid;
}

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
  const AGENT_ID = process.env.BRIDGE_AGENT_ID || `${MACHINE}/cc-${anchorPid()}`;

  // 补注册只带元数据(不带 name/model), 避免覆盖 MCP server 侧的注册; /poll 本身也续心跳
  await bridge("/register", {
    method: "POST",
    body: JSON.stringify({
      agentId: AGENT_ID,
      machine: MACHINE,
      session: sessionId,
      cwd: hook.cwd || process.cwd(),
      pane: process.env.TMUX_PANE || "", // tmux 唤起器用
    }),
  }).catch(() => null);

  const inbox = await bridge(`/poll?agent=${encodeURIComponent(AGENT_ID)}`).catch(() => null);
  if (!inbox) return 0;
  const msgs = inbox.messages || [];
  if (!msgs.length) return 0;
  const text = msgs
    .map((m) => `[session-bridge] 来自 ${m.from}（${m.fromMachine}）${m.urgent ? "【urgent】" : ""}：\n${m.message}`)
    .join("\n---\n") +
    "\n（这是其它 agent 经 session-bridge 发来的消息, 请处理; 回复用 mcp__pi-bridge__session_send, to=发送方 agentId）";
  process.stderr.write(text + "\n");
  return 2; // 阻止停止: stderr 内容作为反馈进入 Claude 下一轮
}
