#!/usr/bin/env node
// pi-session-bridge MCP server — 让任意支持 MCP 的 agent (claude code / codex / gemini cli / ...)
// 使用 bridge 的 session_send / session_list / session_inbox 三个工具。
//
// 零依赖, stdio 传输 (newline-delimited JSON-RPC 2.0, MCP 2024-11-05 兼容)。
// stdout 只承载协议消息; 日志走 stderr。
//
// 配置解析优先级 (与扩展一致):
//   1. 环境变量 BRIDGE_URL / PI_BRIDGE_URL (可选 BRIDGE_TOKEN / PI_BRIDGE_TOKEN)
//   2. ~/.config/pi-bridge/config.json  {bridgeUrl, token, agentName}
//   3. ~/.pi/agent/pi-bridge.json       (与 pi 扩展共用)
// 身份: 默认 <主机名>/cc-<锚定进程pid>(与 Stop hook 共享, 见下方 anchorPid), 可用环境变量
// BRIDGE_AGENT_ID 固定; 显示名自动取 MCP 握手的客户端名+目录名, BRIDGE_AGENT_NAME 可覆盖。
// 注意: MCP 是拉取式 — 收件消息需要 agent 主动调 session_inbox (见 README 的
// claude code Stop-hook 示例可获得自动喂回)。
import child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER_INFO = { name: "pi-session-bridge", version: "0.2.5" };
const log = (...a) => process.stderr.write(`[pi-session-bridge-mcp] ${a.join(" ")}\n`);

function loadConfig() {
  const out = {};
  const candidates = [
    path.join(os.homedir(), ".config", "pi-bridge", "config.json"),
    path.join(os.homedir(), ".pi", "agent", "pi-bridge.json"),
  ];
  for (const p of candidates) {
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

// 锚定到发起 agent 的进程: 沿父进程链跳过 shell 包装层(cmd/bash/pwsh...), 停在第一个
// 非 shell 祖先(即 claude/codex 等本体进程)。MCP server 与 Stop hook 各自独立执行这段
// 逻辑也会得到同一个 pid, 从而共享 <主机名>/cc-<锚pid> 这一个身份与收件箱。
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
const AGENT_ID = process.env.BRIDGE_AGENT_ID || `${MACHINE}/cc-${anchorPid()}`;
let agentName = process.env.BRIDGE_AGENT_NAME || CFG.agentName || ""; // initialize 握手时若仍为空, 自动补 "客户端名-目录名"

if (!BRIDGE_URL) {
  log("BRIDGE_URL 未配置 (环境变量 BRIDGE_URL 或 ~/.config/pi-bridge/config.json), 工具调用将返回设置提示");
}

async function bridge(p, init) {
  const res = await fetch(BRIDGE_URL + p, {
    ...init,
    headers: {
      connection: "close", // 立即回收 socket (Windows 下配合自然退出, 避免 libuv 断言)
      "content-type": "application/json",
      ...(TOKEN ? { "x-bridge-token": TOKEN } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  return res.json();
}

const SETUP_HINT = `session-bridge MCP 未配置 broker 地址。设置环境变量 BRIDGE_URL (如 http://broker-host:3777) 或在 ~/.config/pi-bridge/config.json 写入 {"bridgeUrl":"..."}。`;

async function toolSessionSend(args) {
  if (!BRIDGE_URL) return SETUP_HINT;
  const r = await bridge("/send", {
    method: "POST",
    body: JSON.stringify({ to: args.to, from: AGENT_ID, message: args.message, urgent: !!args.urgent }),
  });
  return r.delivered?.length
    ? `已投递到: ${r.delivered.join(", ")}`
    : `没有匹配的目标 (unknown: ${(r.unknown || []).join(", ") || "none"})`;
}

// 列表展示: 主机名/名字 优先(易读), 方括号内保留完整 agentId; 未命名则直接 agentId
function displayLabel(a) {
  const nm = String(a?.name || "").trim();
  const id = String(a?.agentId || "");
  if (!nm) return id;
  const host = id.split("/")[0] || "";
  return `${host}/${nm}`;
}
function displayLine(a, prefix) {
  const label = displayLabel(a);
  const addr = label === a.agentId ? "" : `  [${a.agentId}]`;
  return `${prefix}${label}${addr}`;
}

async function toolSessionList() {
  if (!BRIDGE_URL) return SETUP_HINT;
  const r = await bridge("/sessions");
  // broker 只返回活跃会话(死亡注册会被 GC); online!==false 过滤用于兼容旧版 broker
  const lines = (r.agents || []).filter((a) => a.online !== false).map((a) =>
    displayLine(a, "") + `  cwd=${a.cwd || "?"}  model=${a.model || "?"}`,
  );
  const q = Object.entries(r.queues || {}).filter(([, n]) => n > 0);
  const ql = q.length ? `\n排队中: ${q.map(([k, n]) => `${k}(${n}条)`).join(", ")}` : "";
  return (lines.join("\n") || "(empty)") + ql + `\n(本端身份: ${AGENT_ID})`;
}

async function toolSessionInbox() {
  if (!BRIDGE_URL) return SETUP_HINT;
  const r = await bridge(`/poll?agent=${encodeURIComponent(AGENT_ID)}`);
  const msgs = r.messages || [];
  if (!msgs.length) return "没有待读消息";
  return msgs.map((m) => `[${m.from}]${m.urgent ? "【urgent】" : ""} ${m.message}`).join("\n---\n");
}

const TOOLS = [
  {
    name: "session_send",
    description:
      "向 bridge 上其他机器/会话的 agent 发消息。to 支持: 对端 agentId(形如 hostA/xxxx, 可用 session_list 查询)、'machine:<主机名>'(该机全部会话)、'all'(全部其他 agent)。urgent=true 时消息在对端当前回合边界注入, 否则排入对端下回合。",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "目标: agentId / machine:<主机名> / all" },
        message: { type: "string", description: "消息正文" },
        urgent: { type: "boolean", description: "可选, 默认 false" },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "session_list",
    description: "列出 bridge 上当前活跃的 agent 会话(下线超过约 90 秒的会被 broker 自动清除)。每行开头是 主机名/名称(/name 命名, 易读); 有名称时其后方括号内是发消息用的完整 agentId, 未命名会话则直接显示 agentId。另含 cwd、model。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "session_inbox",
    description: "取走发往本 agent 的排队消息(MCP 模式为拉取式, 建议在任务开始/结束时各查一次)。",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name, args) {
  try {
    let text;
    if (name === "session_send") text = await toolSessionSend(args || {});
    else if (name === "session_list") text = await toolSessionList();
    else if (name === "session_inbox") text = await toolSessionInbox();
    else return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };
    return { content: [{ type: "text", text: String(text) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `bridge 不可达: ${(e && e.message) || e}` }], isError: true };
  }
}

function handle(msg) {
  const { id, method, params } = msg || {};
  switch (method) {
    case "initialize": {
      // 从握手的 clientInfo 自动取可读显示名(claude-code → claude-<目录名>),
      // 让 bridge 列表里的 MCP 会话不再是一串 mcp-<pid> 裸 ID; BRIDGE_AGENT_NAME 优先
      if (!agentName && params?.clientInfo?.name) {
        const raw = String(params.clientInfo.name).toLowerCase();
        const client = raw.startsWith("claude") ? "claude" : raw;
        const dir = path.basename(process.cwd());
        agentName = [client, dir].filter(Boolean).join("-");
        register();
      }
      return {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      // async — 由外层 await
      return callTool(params?.name, params?.arguments);
    }
    default:
      if (!method) return undefined;
      return { error: { code: -32601, message: `method not found: ${method}` } };
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) onLine(line);
  }
});
process.stdin.on("end", () => {
  // stdin 关闭后等在途请求归零, 然后清掉心跳让事件循环自然排空
  // (Windows 下 process.exit 在流活动时会触发 libuv 断言, 故不用强退)
  const t = setInterval(() => {
    if (pending === 0) {
      clearInterval(t);
      clearInterval(heartbeat);
      process.exitCode = 0;
    }
  }, 100);
});

let pending = 0;
async function onLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  const items = Array.isArray(msg) ? msg : [msg];
  for (const m of items) {
    if (!m || typeof m !== "object") continue;
    if (m.method && m.method.startsWith("notifications/")) continue; // 通知不回包
    const result = handle(m);
    if (result === undefined) continue; // 纯通知
    pending++;
    try {
      const resolved = await result;
      send({ jsonrpc: "2.0", id: m.id ?? null, result: resolved ?? {} });
    } catch (e) {
      send({ jsonrpc: "2.0", id: m.id ?? null, error: { code: -32603, message: String((e && e.message) || e) } });
    } finally {
      pending--;
    }
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// 注册 + 心跳, 让本 agent 出现在 session_list 里 (进程退出即停)
function register() {
  if (!BRIDGE_URL) return;
  bridge("/register", {
    method: "POST",
    body: JSON.stringify({
      agentId: AGENT_ID,
      machine: MACHINE,
      session: AGENT_ID.split("/")[1] || "",
      cwd: process.cwd(),
      name: agentName,
      model: "mcp",
      pane: process.env.TMUX_PANE || "", // tmux 唤起器用: claude 在 tmux 里运行时自带
    }),
  }).catch(() => {});
}
register();
const heartbeat = setInterval(register, 20000);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(heartbeat);
    process.exit(0);
  });
}
log(`started agentId=${AGENT_ID} bridge=${BRIDGE_URL || "(未配置)"}`);
