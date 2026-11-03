#!/usr/bin/env node
// pi-bridge claude waker — 用 tmux send-keys 唤醒空闲的 claude code 会话 (Linux + tmux 环境)。
// 轮询 broker: 本机注册了 pane 元数据的 agent(注册时由 MCP server / Stop hook 写入
// TMUX_PANE)若收件队列有消息, 就把消息逐条"敲"进对应 tmux pane 并回车——
// 等价于替远程 agent 在终端里输入一行 prompt, 休息中的 claude 立即开始处理。
// 消息由 waker 或 Stop hook 先到先得: hook 走 exit 2 喂回(回合末), waker 走 TUI 直打(即时)。
// 注意: 若用户恰好正在该 pane 里打字, 注入内容会与手输混排——本守护不做输入抢占检测。
// 安装: systemd user 服务 pi-bridge-waker (deploy/pi-bridge-waker.service)。
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
const POLL_MS = Number(CFG.pollMs) > 0 ? Number(CFG.pollMs) : 3000;
const log = (...a) => process.stderr.write(`[pi-bridge-waker] ${a.join(" ")}\n`);
if (!BRIDGE_URL) log("BRIDGE_URL 未配置, 唤起器不工作");

async function bridge(p, init) {
  const res = await fetch(BRIDGE_URL + p, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { "x-bridge-token": TOKEN } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  return res.json();
}

const tmux = (args) => {
  try {
    const r = child_process.spawnSync("tmux", args, { encoding: "utf8", timeout: 5000 });
    return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
};

let busy = false;
async function tick() {
  if (busy || !BRIDGE_URL) return;
  busy = true;
  try {
    const s = await bridge("/sessions");
    const mine = (s.agents || []).filter((a) => a.machine === MACHINE && a.pane);
    for (const a of mine) {
      // pane 已死则不取队列, 消息留在 broker 里随注册一起被 GC
      const alive = tmux(["display-message", "-p", "-t", a.pane, "#{pane_id}"]);
      if (!alive.ok) continue;
      const inbox = await bridge(`/poll?agent=${encodeURIComponent(a.agentId)}`).catch(() => null);
      const msgs = (inbox && inbox.messages) || [];
      for (const m of msgs) {
        const text = `[session-bridge] 来自 ${m.from}（${m.fromMachine}）${m.urgent ? "【urgent】" : ""}：\n${m.message}`;
        tmux(["send-keys", "-t", a.pane, "-l", text]);
        tmux(["send-keys", "-t", a.pane, "Enter"]);
        log(`已注入 ${a.agentId} (pane ${a.pane}): 来自 ${m.from}, ${String(m.message).length} 字符`);
      }
    }
  } catch (e) {
    log("tick 失败:", (e && e.message) || e);
  } finally {
    busy = false;
  }
}

tick();
const timer = setInterval(tick, POLL_MS);
timer.unref?.();
// 保活: 显式持有常驻句柄, 防止事件循环被排空后进程退出
setInterval(() => {}, 1 << 30);
