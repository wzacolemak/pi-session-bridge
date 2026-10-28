# pi-session-bridge

跨机 [pi coding agent](https://github.com/earendil-works/pi) 会话通信插件：让不同机器、相互独立的 pi 顶层会话互发消息。语义参考 [dsh-session-bridge](https://github.com/)（DSH 会话桥），针对 pi 的多机部署现实重新设计为 **broker + extension** 两件套。

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  machine A   │     │  machine B   │     │  machine C   │
│  pi (ext) ───┼─────┼─ pi (ext) ───┼─────┼─ pi (ext)    │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │            HTTP    │            HTTP    │
       └────────────┬───────┴────────────────────┘
                    ▼
          broker (任选一台常驻机器, 默认 :3777)
          注册表 + 离线队列 + 在线状态
```

## 组件

| 组件 | 说明 |
| --- | --- |
| `broker/broker.mjs` | 独立消息中继。零依赖，Node >= 16，单文件。维护注册表、按会话离线排队（上限 100 条/会话，溢出丢最旧）、在线状态（30s 心跳窗口）。 |
| `src/session-bridge.ts` | pi 扩展。周期注册 + 拉取消息并注入会话；提供三个工具、两个斜杠命令。 |

## 安装

### 扩展（每台跑 pi 的机器）

**方式一：npm 包（pi >= 0.84 推荐）**

```bash
pi install npm:pi-session-bridge
```

**方式二：源码**

```bash
git clone https://github.com/wzacolemak/pi-session-bridge.git
mkdir -p ~/.pi/agent/extensions
cp pi-session-bridge/src/session-bridge.ts ~/.pi/agent/extensions/
```

方式二无需 `npm install`：pi 内置 typebox，扩展免编译直接加载。

### broker（任选一台常驻机器，如实验室服务器）

```bash
mkdir -p ~/pi-bridge && cp broker/broker.mjs ~/pi-bridge/
node ~/pi-bridge/broker.mjs          # 前台试跑
```

常驻用 systemd user service（见 `deploy/pi-bridge-broker.service`，拷到
`~/.config/systemd/user/` 后 `systemctl --user enable --now pi-bridge-broker`）。

## 配置

扩展按以下优先级解析 broker 地址（**未配置时以未启用状态加载，不发任何请求**）：

1. 环境变量 `PI_BRIDGE_URL`（可选 `PI_BRIDGE_TOKEN`）
2. 项目级 `./.pi/pi-bridge.json`
3. 全局 `~/.pi/agent/pi-bridge.json`：

```json
{ "bridgeUrl": "http://broker-host:3777", "token": "可选", "pollMs": 5000 }
```

broker 环境变量：`BRIDGE_PORT`（默认 3777）、`BRIDGE_TOKEN`（设置后所有请求须带
`x-bridge-token` 头，扩展侧填配置里的 `token` 即可）。

## 工具（agent 可调用）

| 工具 | 作用 |
| --- | --- |
| `session_send` | 发消息。`to` 支持：对端 agentId（形如 `hostA/xxxx`）、`machine:<主机名>`（该机全部会话）、`all`（全部其他 agent）。`urgent: true` 走 steer 注入对端当前回合，否则排入对端下回合。 |
| `session_list` | 列出全部注册会话（agentId、cwd、模型、在线状态、各会话排队数）。 |
| `session_inbox` | 立即取走发往本会话的排队消息（通常无需主动调用）。 |

命令：`/peers` 列出对端，`/bridge` 查看本端注册状态与配置。

## 投递语义

- 收到的消息以用户消息形态进入目标会话上下文，正文带发件方 `machine/sessionId` 标识；收件 agent 可用 `session_send` 回信。
- `urgent` 消息经 `sendUserMessage(steer)` 在对端当前回合的工具调用边界注入（不取消正在执行的请求）；普通消息走 followUp 排队；会话空闲时自动唤醒新回合。
- 拉取失败自动降级：steer → 普通注入 → 自定义消息注入，逐级兜底。
- 会话离线时消息在 broker 排队（每会话上限 100 条、单条 20000 字符），上线即送达。
- 无父子关系：桥接消息不产生 subagent，收发双方都是真正的顶层会话。

## 安全

- 扩展以你的完整 OS 权限运行，broker 默认**无鉴权**——只应在可信内网使用；跨网段务必设置 `BRIDGE_TOKEN` 并在扩展配置里填同值 `token`。
- broker 的离线队列存内存，进程重启即失；注册表持久化到同目录 `state.json`。

## License

[MIT](LICENSE)
