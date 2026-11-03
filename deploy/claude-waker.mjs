#!/usr/bin/env node
// pi-bridge claude waker v3 — 唤醒空闲的 claude code 会话 (Linux)。
// 唤醒 = 向持有 claude 输入通道的一侧注入按键。可行策略:
//   1) tmux pane (注册元数据 pane): tmux send-keys 精确投递到指定 pane
//   2) GNU screen (注册元数据 sty+window): screen -p <窗口号> -X stuff,
//      按窗口号精确定位, 不受当前焦点窗口影响
// 注意: TIOCSTI 跨进程注入不可行 —— 内核只允许注入自己会话的控制终端
// (实测 EPERM, 须 CAP_SYS_ADMIN 才能注入他人终端), 已排除该路线。
// 裸 SSH / 桌面终端 / VS Code 集成终端里的会话无法外部唤醒: 消息留在
// broker 队列, 由 Stop hook 在下个回合末喂回 —— 任何情况不丢消息。
// 只处理本机 agentId 形如 <host>/cc-<pid> 的会话 —— pi 会话有自己的轮询
// 扩展, 其它未知 agent 的投递方式不明, 一律不代收(否则会偷走消息)。
// 注意: 注入与用户手输可能混排(无抢占检测); 多行消息压成单行(\n → " / "),
// 避免 TUI 输入框在换行处提前提交。
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
const INJECT_CAP = 4000; // 注入单行长度上限(完整消息仍受 broker 20000 限制)
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

const run = (cmd, args) => {
  try {
    const r = child_process.spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
    return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
};

// 多行压单行: TUI 输入框把 \r/\n 当提交键, 直接注入会截断消息
const flatten = (t) => String(t).replace(/\s*[\r\n]+\s*/g, " / ").slice(0, INJECT_CAP);

// --- 策略 1: tmux send-keys ---
function wakeTmux(pane, flat) {
  const alive = run("tmux", ["display-message", "-p", "-t", pane, "#{pane_id}"]);
  if (!alive.ok) return false;
  const a = run("tmux", ["send-keys", "-t", pane, "-l", flat]);
  const b = run("tmux", ["send-keys", "-t", pane, "Enter"]);
  return a.ok && b.ok;
}

// --- 策略 2: GNU screen stuff (按窗口号定位) ---
function wakeScreen(sty, win, flat) {
  const r = run("screen", ["-S", sty, "-p", win, "-X", "stuff", flat + "\n"]);
  return r.ok;
}

// 锚 pid 存活检查(死进程的注册等 GC, 不取队列以免丢消息)
const pidAlive = (pid) => { try { fs.accessSync(`/proc/${pid}`); return true; } catch { return false; } };

const CC_RE = new RegExp(`^${MACHINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/cc-(\\d+)$`);

let busy = false;
async function tick() {
  if (busy || !BRIDGE_URL) return;
  busy = true;
  try {
    const s = await bridge("/sessions");
    const mine = (s.agents || []).filter((a) => CC_RE.test(a.agentId));
    for (const a of mine) {
      const pid = Number(a.agentId.match(CC_RE)[1]);
      if (!pidAlive(pid)) continue;
      // 无可用唤醒通道的会话不动队列(Stop hook 兜底), 也省一次 poll
      // (screen 窗口号为空时不投: -p "" 会落到当前焦点窗口, 有切错目标风险)
      if (!a.pane && !(a.sty && a.window)) continue;
      const inbox = await bridge(`/poll?agent=${encodeURIComponent(a.agentId)}`).catch(() => null);
      const msgs = (inbox && inbox.messages) || [];
      for (const m of msgs) {
        const text = `[session-bridge] 来自 ${m.from}（${m.fromMachine}）${m.urgent ? "【urgent】" : ""}：${m.message}`;
        const flat = flatten(text);
        let how = "";
        if (a.pane && wakeTmux(a.pane, flat)) how = `tmux ${a.pane}`;
        else if (a.sty && a.window && wakeScreen(a.sty, a.window, flat)) how = `screen ${a.sty} win=${a.window}`;
        if (!how) {
          // 策略失败: 消息已被取走会丢, 塞回队列尾部交给 Stop hook
          log(`唤醒失败(${a.agentId}), 消息回队`);
          await bridge("/send", {
            method: "POST",
            body: JSON.stringify({ to: a.agentId, from: m.from, message: m.message, urgent: !!m.urgent }),
          }).catch(() => {});
          continue;
        }
        log(`已注入 ${a.agentId} via ${how}: 来自 ${m.from}, ${flat.length} 字符`);
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
