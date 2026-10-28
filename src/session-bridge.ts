// pi session-bridge — 跨机 pi 会话通信扩展
// 仓库: https://github.com/wzacolemak/pi-session-bridge
// 语义参考 dsh-session-bridge: 顶层会话之间无父子关系地互发消息。
//
// 配置解析优先级:
//   1. 环境变量 PI_BRIDGE_URL / PI_BRIDGE_TOKEN
//   2. 项目配置 ./.pi/pi-bridge.json
//   3. 全局配置 ~/.pi/agent/pi-bridge.json
//      形如 {"bridgeUrl": "http://broker-host:3777", "token": "可选", "pollMs": 5000}
// 未配置时扩展以「未启用」状态加载: 工具返回设置提示, 不发起任何网络请求。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface BridgeConfig {
  bridgeUrl?: string;
  token?: string;
  pollMs?: number;
}

function loadConfig(): BridgeConfig {
  const out: BridgeConfig = {};
  const candidates = [
    path.join(process.cwd(), ".pi", "pi-bridge.json"),
    path.join(os.homedir(), ".pi", "agent", "pi-bridge.json"),
  ];
  for (const p of candidates) {
    try {
      Object.assign(out, JSON.parse(fs.readFileSync(p, "utf8")));
      break;
    } catch {}
  }
  if (process.env.PI_BRIDGE_URL) out.bridgeUrl = process.env.PI_BRIDGE_URL;
  if (process.env.PI_BRIDGE_TOKEN) out.token = process.env.PI_BRIDGE_TOKEN;
  return out;
}

const CFG = loadConfig();
const BRIDGE_URL = (CFG.bridgeUrl || "").replace(/\/+$/, "");
const TOKEN = CFG.token || "";
const POLL_MS = Number(CFG.pollMs) > 0 ? Number(CFG.pollMs) : 5000;
const CONFIGURED = BRIDGE_URL.length > 0;
const SETUP_HINT =
  `session-bridge 未配置。在 ~/.pi/agent/pi-bridge.json 写入 {"bridgeUrl":"http://broker-host:3777"} ` +
  `(或设置环境变量 PI_BRIDGE_URL)。broker 部署见仓库 README。`;

const MACHINE = (os.hostname().split(".")[0] || "unknown").toLowerCase();

export default function (pi: ExtensionAPI) {
  let sessionId = "";
  let agentId = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let tick = 0;
  let busy = false;
  const fallbackId = `p${process.pid}-${Math.random().toString(36).slice(2, 6)}`;

  const resolveAgentId = (ctx?: any): string => {
    if (!sessionId) {
      sessionId =
        ctx?.sessionManager?.getSessionId?.() ||
        ctx?.sessionManager?.session?.id ||
        fallbackId;
    }
    if (!agentId) agentId = `${MACHINE}/${sessionId}`;
    return agentId;
  };

  const api = async (p: string, init?: any) => {
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
  };

  const register = (ctx?: any) =>
    api("/register", {
      method: "POST",
      body: JSON.stringify({
        agentId: resolveAgentId(ctx),
        machine: MACHINE,
        session: sessionId,
        cwd: ctx?.cwd || process.cwd(),
        name: ctx?.sessionManager?.getSessionName?.() || "",
        model: ctx?.model?.id || "",
      }),
    }).catch(() => {});

  const poll = async (ctx?: any): Promise<any[]> => {
    const r = await api(`/poll?agent=${encodeURIComponent(resolveAgentId(ctx))}`);
    return r.messages || [];
  };

  const deliver = (m: any) => {
    const text = `[session-bridge] 来自 ${m.from}（${m.fromMachine}）${m.urgent ? "【urgent】" : ""}：\n${m.message}`;
    try {
      if (m.urgent) return pi.sendUserMessage(text, { deliverAs: "steer" });
      return pi.sendUserMessage(text, { deliverAs: "followUp" });
    } catch {
      try {
        return pi.sendUserMessage(text);
      } catch {
        return pi.sendMessage(
          { customType: "session_bridge_message", content: text, display: true },
          { triggerTurn: true },
        );
      }
    }
  };

  const startPolling = (ctx?: any) => {
    if (timer || !CONFIGURED) return;
    register(ctx);
    timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        tick++;
        if (tick % 10 === 1) register();
        const msgs = await poll();
        for (const m of msgs) {
          try {
            deliver(m);
          } catch {}
        }
      } catch {
      } finally {
        busy = false;
      }
    }, POLL_MS);
  };

  pi.on?.("session_start", (...args: any[]) => {
    sessionId = "";
    agentId = "";
    startPolling(args?.[1]);
  });
  pi.on?.("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
  startPolling();

  pi.registerTool({
    name: "session_send",
    description:
      "向其他机器/会话上的 pi agent 发消息。to 支持: 对端 agentId(形如 hostA/xxxx, 可用 session_list 查询)、'machine:<主机名>'(该机全部会话)、'all'(全部在线 agent)。urgent=true 时注入对端当前回合(steer), 否则排入对端下回合。",
    parameters: Type.Object({
      to: Type.String({ description: "目标: agentId / machine:<主机名> / all" }),
      message: Type.String({ description: "消息正文" }),
      urgent: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      if (!CONFIGURED)
        return { content: [{ type: "text", text: SETUP_HINT }], details: {} };
      try {
        const r = await api("/send", {
          method: "POST",
          body: JSON.stringify({
            to: params.to,
            from: resolveAgentId(),
            message: params.message,
            urgent: !!params.urgent,
          }),
        });
        const text = r.delivered?.length
          ? `已投递到: ${r.delivered.join(", ")}`
          : `没有匹配的目标 (unknown: ${(r.unknown || []).join(", ") || "none"})`;
        return { content: [{ type: "text", text }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `bridge 不可达: ${e?.message || e}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "session_list",
    description:
      "列出 bridge 上全部已注册的 pi 会话(agentId、机器、工作目录、模型、是否在线)。",
    parameters: Type.Object({}),
    async execute() {
      if (!CONFIGURED)
        return { content: [{ type: "text", text: SETUP_HINT }], details: {} };
      try {
        const r = await api("/sessions");
        const lines = (r.agents || []).map(
          (a: any) =>
            `${a.online ? "[online] " : "[stale ] "}${a.agentId}  cwd=${a.cwd || "?"}  model=${a.model || "?"}`,
        );
        const q = Object.entries(r.queues || {}).filter(([, n]) => (n as number) > 0);
        const ql = q.length ? `\n排队中: ${q.map(([k, n]) => `${k}(${n}条)`).join(", ")}` : "";
        return { content: [{ type: "text", text: lines.join("\n") + ql }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `bridge 不可达: ${e?.message || e}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "session_inbox",
    description:
      "立即取走发往本会话的排队消息(通常无需主动调用, 扩展周期性自动拉取并注入)。",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!CONFIGURED)
        return { content: [{ type: "text", text: SETUP_HINT }], details: {} };
      try {
        const msgs = await poll(ctx);
        if (!msgs.length) return { content: [{ type: "text", text: "没有待读消息" }], details: {} };
        return {
          content: [
            { type: "text", text: msgs.map((m: any) => `[${m.from}] ${m.message}`).join("\n---\n") },
          ],
          details: {},
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `bridge 不可达: ${e?.message || e}` }], details: {} };
      }
    },
  });

  pi.registerCommand?.("peers", {
    description: "列出 bridge 上的全部 pi 会话",
    handler: async (_args: string, ctx: any) => {
      if (!CONFIGURED) return void (await ctx?.ui?.notify?.(SETUP_HINT, "warning"));
      try {
        const r = await api("/sessions");
        const lines = (r.agents || []).map(
          (a: any) => `${a.online ? "●" : "○"} ${a.agentId}  ${a.cwd || ""}`,
        );
        await ctx?.ui?.notify?.(lines.join("\n") || "(empty)", "info");
      } catch (e: any) {
        await ctx?.ui?.notify?.(`bridge 不可达: ${e?.message || e}`, "warning");
      }
    },
  });

  pi.registerCommand?.("bridge", {
    description: "查看 session-bridge 状态",
    handler: async (_args: string, ctx: any) => {
      await ctx?.ui?.notify?.(
        `bridge=${CONFIGURED ? BRIDGE_URL : "(未配置)"}\nagentId=${resolveAgentId(ctx)}\npolling=${timer ? "on" : "off"}${CONFIGURED ? ` (every ${POLL_MS}ms)` : ""}\ntoken=${TOKEN ? "yes" : "no"}`,
        "info",
      );
    },
  });
}
