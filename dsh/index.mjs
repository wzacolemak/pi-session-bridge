/** pi-session-bridge dsh relay — 把 dsh 会话接入 pi-session-bridge broker，
 * 与其它机器上的 pi / claude code / 任意 MCP agent 互发消息。
 * 每个顶层 dsh 会话映射为 bridge 身份 `<主机名>/dsh-<sessionId>`：
 * 全部会话周期注册（冷会话可随时 resume，消息在 broker 排队不丢），
 * 活跃会话周期 poll 收件并以 steer(urgent)/followup 注入。
 * 与 dsh-session-bridge（机箱内插件）互补而非替代，二者请勿同时安装（工具名会冲突）。
 * @module pi-session-bridge-dsh */
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import os from 'node:os'

// 从运行中的 dsh 进程解析 harness 包（与 dsh-session-bridge 相同的策略，
// 避免依赖包副本）。argv[1] 须先 realpath: 通过 bin 符号链接启动时,
// 符号链接目录向上爬不到 dsh 包内嵌的 node_modules（dsh-llm 等）。
const runtimeAnchors = [
  process.env.DSH_RUNTIME_ENTRY,
  (() => { try { return realpathSync(process.argv[1]) } catch { return process.argv[1] } })(),
].filter(Boolean)
function resolveHarness (id, extraAnchors = []) {
  const errors = []
  for (const anchor of [...runtimeAnchors, ...extraAnchors]) {
    try {
      return createRequire(anchor).resolve(id)
    } catch (error) {
      errors.push(error)
    }
  }
  throw new Error(`pi-session-bridge-dsh: cannot resolve runtime package "${id}"; install this package in a DSH profile or set DSH_RUNTIME_ENTRY (${errors[0]?.message ?? 'no anchor'})`)
}
// Windows 下 ESM import() 不接受 C:\ 裸路径, 一律转 file:// URL
const runtimeImport = async (id, extraAnchors = []) => await import(pathToFileURL(resolveHarness(id, extraAnchors)).href)

// Import sequentially: CJS bridges can race concurrent ESM imports of shared
// Cordis dependencies under Node 22.
const { createUserMessage } = await runtimeImport('@deepseek-ai/dsh-llm')
const llmAnchor = resolveHarness('@deepseek-ai/dsh-llm')
const { default: z } = await runtimeImport('@deepseek-ai/schemastery', [llmAnchor])
const { defineTool } = await runtimeImport('@deepseek-ai/dsh-tools')

export const name = 'pi-session-bridge'
export const inject = ['tools', 'agents', 'systemPrompt']

export const Config = z.object({
  /** broker 地址, 如 http://broker-host:3777; 留空时回退环境变量 PI_BRIDGE_URL/BRIDGE_URL */
  bridgeUrl: z.string().default(''),
  /** 可选鉴权 token (broker BRIDGE_TOKEN 对应) */
  token: z.string().default(''),
  /** 轮询周期 ms: 注册全部会话 + 对活跃会话取件 */
  pollMs: z.natural().min(500).default(3000),
  /** 是否向 agent 系统提示注入使用公告 */
  announceToAgent: z.boolean().default(true),
})

const MACHINE = (os.hostname().split('.')[0] || 'unknown').toLowerCase()
const MSG_CAP = 20000
/** 公告在工具引导带的顺序（避开 dsh-session-bridge 的 155）。 */
const SECTION_ORDER = 156

const bridgeIdOf = (sessionId) => `${MACHINE}/dsh-${sessionId}`
const SETUP_HINT =
  'pi-session-bridge relay 未配置 broker 地址：在 profile 的 cordis.patch.yml 写入 ' +
  '- id: pi-session-bridge / config: { bridgeUrl: "http://broker-host:3777" }，' +
  '或设置环境变量 PI_BRIDGE_URL / BRIDGE_URL。'

/** 顶层会话清单（排除 subagent），与 dsh-session-bridge 相同的取数路径。 */
function makeListTopLevel (ctx) {
  return async () => {
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      const records = await query.listSessions()
      return records
        .filter(record => record.header.origin !== 'subagent' && record.header.parentSession === undefined)
        .map(record => ({
          sessionId: String(record.header.id),
          title: record.header.title ?? '',
          cwd: record.header.cwd ?? '',
          live: record.live === true,
        }))
    }
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return []
    const headers = await persistence.list()
    return headers
      .filter(header => header.origin !== 'subagent' && header.parentSession === undefined)
      .map(header => ({
        sessionId: String(header.id),
        title: header.title ?? '',
        cwd: header.cwd ?? '',
        live: ctx.agents.get(String(header.id)) !== undefined,
      }))
  }
}

function createRelay (ctx, config) {
  const BRIDGE_URL = String(config?.bridgeUrl || process.env.PI_BRIDGE_URL || process.env.BRIDGE_URL || '').replace(/\/+$/, '')
  const TOKEN = String(config?.token || process.env.PI_BRIDGE_TOKEN || process.env.BRIDGE_TOKEN || '')
  const pollMs = config?.pollMs ?? 3000

  const api = async (path, init) => {
    const res = await fetch(BRIDGE_URL + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(TOKEN ? { 'x-bridge-token': TOKEN } : {}),
        ...(init?.headers || {}),
      },
    })
    if (!res.ok) throw new Error(`bridge ${res.status}`)
    return res.json()
  }

  const listTopLevel = makeListTopLevel(ctx)

  /** 把一条跨机消息作为用户消息注入活跃 agent（不属于任何发起方的子链）。 */
  const deliverLive = (agent, m) => {
    const text = [
      m.urgent ? '[跨机加急消息 / urgent cross-machine message]' : '[跨机消息 / cross-machine message]',
      `from: ${m.from}（${m.fromMachine || ''}）`,
      '',
      m.message,
      '',
      '（用 session_send 工具回信, to 为上面的 from）',
    ].join('\n')
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    ctx.agents.withoutInitiator(() => {
      if (m.urgent) {
        try {
          agent.steer(message)
          return
        } catch { /* steer 不可用时降级为普通排队 */ }
      }
      agent.followup(message)
    })
  }

  let busy = false
  const tick = async () => {
    if (busy || !BRIDGE_URL) return
    busy = true
    try {
      const sessions = await listTopLevel()
      // 全部会话注册心跳(冷会话也在 bridge 列表可见、可收排队消息; dsh 会话被
      // 删除后不再注册, 90s 后被 broker TTL 清除)。注册失败静默。
      for (const s of sessions) {
        api('/register', {
          method: 'POST',
          body: JSON.stringify({
            agentId: bridgeIdOf(s.sessionId),
            machine: MACHINE,
            session: s.sessionId,
            cwd: s.cwd,
            name: s.title,
            model: 'dsh',
          }),
        }).catch(() => {})
      }
      // 只对活跃会话取件; 冷会话的消息留在 broker 队列, 会话激活后自动送达
      for (const s of sessions.filter(e => e.live)) {
        const inbox = await api(`/poll?agent=${encodeURIComponent(bridgeIdOf(s.sessionId))}`).catch(() => null)
        if (!inbox || !(inbox.messages || []).length) continue
        const agent = ctx.agents.get(s.sessionId)
        if (agent === undefined) {
          console.error(`[pi-session-bridge-dsh] live 会话 ${s.sessionId} 取到 ${inbox.messages.length} 条消息但 agents.get 返回空`)
          continue
        }
        for (const m of inbox.messages) {
          try {
            deliverLive(agent, m)
          } catch (e) {
            console.error(`[pi-session-bridge-dsh] 投递失败(${s.sessionId}):`, e?.message || e)
          }
        }
      }
    } catch (e) {
      console.error('[pi-session-bridge-dsh] tick 失败:', e?.message || e)
    } finally {
      busy = false
    }
  }

  const startPolling = () => {
    if (!BRIDGE_URL) {
      console.error('[pi-session-bridge-dsh] bridgeUrl 未配置, relay 不工作 (工具将返回设置提示)')
      return () => {}
    }
    void tick()
    const timer = setInterval(() => { void tick() }, pollMs)
    return () => clearInterval(timer)
  }

  // ---- tools ----

  const sendTool = defineTool({
    name: 'session_send',
    description: '向其它机器上的 agent 会话（pi / claude code / 其它 dsh 会话）发消息。to 为对方完整 agentId（形如 hostA/xxxx，用 session_list 查询），也支持 machine:<主机名>（该机全部会话）与 all。urgent=true 时若目标活跃会在其最近回合边界加急注入。Triggers: 跨机通信、通知/询问其它 agent、多机协作、回复收到的跨机消息。',
    parameters: {
      to: { type: 'string', required: true, description: '目标: 完整 agentId / machine:<主机名> / all' },
      message: { type: 'string', required: true, description: '消息正文' },
      urgent: { type: 'boolean', description: '可选, 默认 false' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          to: { type: 'string', required: true },
          delivered: { type: 'array', required: true, items: { type: 'string' } },
          unknown: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered.length
          ? `已投递到: ${value.delivered.join(', ')}`
          : `没有匹配的目标 (unknown: ${value.unknown.join(', ') || 'none'})`,
      }],
    },
    async execute (args, exec) {
      if (!BRIDGE_URL) throw new Error(`session_send: ${SETUP_HINT}`)
      const callerId = exec.agent?.session?.id
      if (callerId === undefined) throw new Error('session_send: no calling session identity')
      const r = await api('/send', {
        method: 'POST',
        body: JSON.stringify({
          to: args.to,
          from: bridgeIdOf(String(callerId)),
          message: String(args.message).slice(0, MSG_CAP),
          urgent: args.urgent === true,
        }),
      })
      return {
        to: args.to,
        delivered: (r.delivered ?? []).map(String),
        unknown: (r.unknown ?? []).map(String),
      }
    },
  })

  const listTool = defineTool({
    name: 'session_list',
    description: '列出 pi-session-bridge broker 上所有机器的活跃 agent 会话（pi、claude code、dsh 等），含 主机/名称、完整 agentId、工作目录与模型。用完整 agentId 作为 session_send 的目标。Triggers: 查看有哪些可用会话、寻找消息目标。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agentId: { type: 'string', required: true },
                machine: { type: 'string' },
                name: { type: 'string' },
                cwd: { type: 'string' },
                model: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.sessions.length === 0
          ? '（bridge 上没有活跃会话）'
          : value.sessions.map(a => {
              const label = a.name ? `${a.machine}/${a.name}` : a.agentId
              const addr = label === a.agentId ? '' : `  [${a.agentId}]`
              return `${label}${addr}  cwd=${a.cwd || '?'}  model=${a.model || '?'}`
            }).join('\n'),
      }],
    },
    async execute () {
      if (!BRIDGE_URL) throw new Error(`session_list: ${SETUP_HINT}`)
      const r = await api('/sessions')
      return {
        sessions: (r.agents ?? []).map(a => ({
          agentId: String(a.agentId ?? ''),
          machine: String(a.machine ?? ''),
          name: String(a.name ?? ''),
          cwd: String(a.cwd ?? ''),
          model: String(a.model ?? ''),
        })),
      }
    },
  })

  const inboxTool = defineTool({
    name: 'session_inbox',
    description: '手动取走发往本会话的跨机排队消息。通常无需调用——活跃会话的消息由 relay 自动注入；这是兜底。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string', required: true },
                fromMachine: { type: 'string' },
                text: { type: 'string', required: true },
                urgent: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? '没有待读消息'
          : value.messages.map(m => `${m.urgent ? '[urgent] ' : ''}from ${m.from}（${m.fromMachine}）:\n${m.text}`).join('\n---\n'),
      }],
    },
    async execute (_args, exec) {
      if (!BRIDGE_URL) throw new Error(`session_inbox: ${SETUP_HINT}`)
      const callerId = exec.agent?.session?.id
      if (callerId === undefined) throw new Error('session_inbox: no calling session identity')
      const r = await api(`/poll?agent=${encodeURIComponent(bridgeIdOf(String(callerId)))}`)
      return {
        messages: (r.messages ?? []).map(m => ({
          from: String(m.from ?? ''),
          fromMachine: String(m.fromMachine ?? ''),
          text: String(m.message ?? ''),
          urgent: m.urgent === true,
        })),
      }
    },
  })

  const guidance = `本机已安装 pi-session-bridge（dsh relay）：可与其它机器上的 pi / claude code 会话互发消息。session_list 列出 broker 上所有机器的活跃会话（每行含 主机/名称 与方括号内的完整 agentId）；session_send 向其它会话发消息（to=对方完整 agentId，或 machine:<主机名>、all；urgent=true 加急注入目标当前回合）；session_inbox 手动取件（通常无需调用——发往本机 dsh 会话的消息会自动以用户消息形态注入）。跨机消息消耗真实 API 额度；收到消息后用 session_send 回信（to 为消息头里的 from）。本机 dsh 会话的 bridge 身份是 <主机名>/dsh-<sessionId>。用户提到「跨机通信 / 给 pi 或 claude 发消息 / 会话间传消息」时即指本插件。`

  return {
    tools: [sendTool, listTool, inboxTool],
    guidance,
    startPolling,
  }
}

/**
 * Mount relay tools, the system-prompt announcement, and the poller.
 * @param ctx - host plugin context carrying tools/agents/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply (ctx, config) {
  const relay = createRelay(ctx, config)
  if (config?.announceToAgent !== false) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'plugin:pi-session-bridge',
      order: SECTION_ORDER,
      text: relay.guidance,
    }), 'pi-session-bridge: announcement')
  }
  ctx.effect(() => {
    const disposers = relay.tools.map(tool => ctx.tools.register(tool))
    return () => { for (const dispose of disposers) dispose() }
  }, 'pi-session-bridge: tools')
  ctx.effect(() => relay.startPolling(), 'pi-session-bridge: poller')
}
