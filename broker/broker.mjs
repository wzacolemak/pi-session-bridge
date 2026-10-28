// pi-bridge broker — 跨机 pi 会话消息中继（零依赖，Node >= 16）
// 部署在任选一台常驻机器: ~/pi-bridge/broker.mjs, 端口 3777
// 端点:
//   POST /register {agentId, machine, session, cwd, name, model}
//   POST /send     {to, from, message, urgent}   to = agentId | "machine:<host>" | "all"
//   GET  /poll?agent=<agentId>                   取走并清空该 agent 的队列(顺带心跳)
//   GET  /sessions                               全部 agent(带 online 标记)
//   GET  /health
// 可选: BRIDGE_TOKEN 环境变量 → 请求须带 x-bridge-token 头
import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.BRIDGE_PORT || 3777);
const TOKEN = process.env.BRIDGE_TOKEN || "";
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "state.json");
const QUEUE_CAP = 100;        // 每 agent 离线排队上限(对齐 dsh maxPendingPerSession)
const MSG_CAP = 20000;        // 单条正文上限(对齐 dsh maxMessageChars)
const ONLINE_MS = 30 * 1000;  // lastSeen 超过此值视为 offline

const state = { agents: {}, queues: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch {}
state.agents ??= {}; state.queues ??= {};

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
  }, 300);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > 1e6) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
const auth = (req) => !TOKEN || req.headers["x-bridge-token"] === TOKEN;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (!auth(req)) return json(res, 403, { error: "bad token" });

    if (req.method === "POST" && url.pathname === "/register") {
      const b = await readBody(req);
      if (!b.agentId) return json(res, 400, { error: "agentId required" });
      state.agents[b.agentId] = { ...state.agents[b.agentId], ...b, lastSeen: Date.now() };
      save();
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/send") {
      const b = await readBody(req);
      const message = String(b.message ?? "").slice(0, MSG_CAP);
      if (!b.to || !message) return json(res, 400, { error: "to/message required" });
      let targets = [];
      if (b.to === "all") targets = Object.keys(state.agents).filter((a) => a !== b.from);
      else if (b.to.startsWith("machine:")) {
        const m = b.to.slice(8).toLowerCase();
        targets = Object.keys(state.agents).filter((a) => a.toLowerCase().startsWith(m + "/") && a !== b.from);
      } else targets = [b.to];
      const delivered = [], unknown = [];
      for (const t of targets) {
        if (!state.agents[t] && b.to === t) { unknown.push(t); continue; }
        state.agents[t] ??= { agentId: t, machine: t.split("/")[0], lastSeen: 0 };
        state.queues[t] ??= [];
        state.queues[t].push({ from: b.from, fromMachine: String(b.from || "").split("/")[0], message, urgent: !!b.urgent, ts: Date.now() });
        if (state.queues[t].length > QUEUE_CAP) state.queues[t].shift();
        delivered.push(t);
      }
      save();
      return json(res, 200, { ok: true, delivered, unknown });
    }

    if (req.method === "GET" && url.pathname === "/poll") {
      const agent = url.searchParams.get("agent");
      if (!agent) return json(res, 400, { error: "agent required" });
      if (state.agents[agent]) state.agents[agent].lastSeen = Date.now();
      const messages = state.queues[agent] ?? [];
      delete state.queues[agent];
      save();
      return json(res, 200, { messages });
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      const now = Date.now();
      const agents = Object.entries(state.agents)
        .map(([agentId, a]) => ({ ...a, online: now - (a.lastSeen || 0) < ONLINE_MS }))
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      const queues = Object.fromEntries(Object.entries(state.queues).map(([k, v]) => [k, v.length]));
      return json(res, 200, { agents, queues });
    }

    if (req.method === "GET" && url.pathname === "/health")
      return json(res, 200, { ok: true, uptime: process.uptime() });

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`[pi-bridge] listening on :${PORT}`));
