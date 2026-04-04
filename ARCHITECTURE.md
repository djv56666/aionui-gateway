# AionUI Gateway — 企业级架构设计

> 本文档记录 AionUI Gateway 企业化演进的架构设计，作为后续开发的蓝图。

---

## 一、项目定位

AionUI Gateway 从"多用户 OAuth2 认证网关"演进为**企业级 AI 工作平台的控制面**。

核心目标：
- **SSO 登录** — 企业员工通过统一认证进入专属工作区
- **资源管理** — 统一管控模型配置、API Key、Token 用量、运行实例
- **Agent 管理** — 员工创建/使用 Agent，固化业务流程，沉淀为企业数字资产
- **Skill 管理** — 最小可复用能力单元，跨 Agent 共享
- **24h Agent** — 个人数字助理 & 部门数字化身，常驻运行
- **定时任务** — 由 Agent 执行的周期性自动化任务
- **知识库 / MCP 接口 / 通知渠道** — 企业级基础设施统一管理

---

## 二、核心概念模型

```
企业 (Tenant)
 ├── 部门 (Department)
 │    ├── 部门数字化身 (Dept Agent)         ← 24h 常驻容器
 │    ├── 部门知识库 (Knowledge Base)
 │    └── 员工 (User)
 │         ├── AionUI 工作区                ← 按需启动，空闲回收
 │         ├── 个人数字助理 (Personal Agent) ← 24h 常驻容器
 │         ├── 个人 Agent 集合              ← 按需启停
 │         └── 个人 Skill 集合
 │
 ├── 企业级 Agent 库（可分发到部门/个人）
 ├── 企业级 Skill 库
 ├── MCP 接口市场
 ├── 模型配置 & Token 用量
 └── 管理后台（RBAC）
```

### Agent 分层

| 层级 | 创建者 | 可见范围 | 说明 |
|------|--------|---------|------|
| 个人 Agent | 员工 | 仅创建者 | 个人固化的工作流程 |
| 部门 Agent | 部门管理员 | 部门内 | 部门共享，含数字化身 |
| 企业 Agent | 企业管理员 | 全企业 | 审核后发布，企业数字资产 |

个人 Agent 可申请升级为部门/企业级。

### 两类容器实例

| 类型 | 生命周期 | 用途 | 运行形式 |
|------|---------|------|---------|
| **AionUI 工作区** | 按需启动，空闲回收 | 员工日常交互 | Docker 容器 |
| **Agent 容器** | 24h 常驻 或 按需启停 | 定时任务、记忆、消息通知、业务自动化 | Docker 容器（每 Agent 独立） |

---

## 三、整体架构

```
                    ┌─────────────────────────────────────────┐
                    │           AionUI Gateway                │
                    │         (Express + Node.js)             │
  ┌─────────────┐   │                                         │
  │  SSO/OAuth  │──►│  ┌──────────┐  ┌──────────────────────┐ │
  │  SAML/OIDC  │   │  │ Auth 模块 │  │    管理 API 层       │ │
  │  CAS        │   │  └──────────┘  │  /api/admin/*        │ │
  └─────────────┘   │                │  /api/user/*         │ │
                    │                │                      │ │
  ┌─────────────┐   │  ┌──────────┐  │  · RBAC 权限         │ │
  │  管理后台    │──►│  │PostgreSQL│  │  · Agent/Skill CRUD  │ │
  │  (内嵌 SPA) │   │  │(元数据)  │  │  · 资源监控          │ │
  └─────────────┘   │  └──────────┘  │  · Token 用量统计    │ │
                    │                │  · 定时任务管理      │ │
                    │                │  · 知识库管理        │ │
                    │                │  · MCP 接口管理      │ │
                    │                └──────────────────────┘ │
                    │                                         │
                    │  ┌──────────────┐  ┌─────────────────┐  │
                    │  │  反向代理      │  │  Container      │  │
                    │  │(HTTP+WS)     │  │  Manager        │  │
                    │  └──┬──┬───────  │  (Docker CLI)   │  │
                    └─────┬──┬──────────┬──────────┠─────────│  │
                          │   │                    │           │
          ┌────────────────────   │                    │           │
          ▼                   ▼                    ▼
   ┌────────────    ┌───────────       ┌──────────────────────│
   │  AionUI    │    │  AionUI   │       │  Agent 容器群   │
   │  工作区     │    │  工作区    │       │                │
   │  (员工A)    │    │  (员工B)  │       │ ┌────────────│ │
   └──┬──┬─────      └──┬──┬─────       │ │ Sidecar    │ │
     │   │              │   │            │ │ (心跳/cron)│ │
     │   │  ①请求连接    │   │            │ │ ACP Bridge │ │
     │   └────────────────────┠│   │     │ ├─────────────│ │
     │╌──┤ 返回直连地址   │   │            │ │ opencode   │ │
     │   │              │   │            │ │ acp :3001  │ │
     │   │  ②直连 ACP    │   │            │ └─────────────│ │
     │   └────────────────────────────────────────────────┠│
     │╌──ACP 流式响应───────────────────────────────────────────││
                                       └──────────────────────────│
                                               × N
                                   每个 Agent 独立容器
```

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 管理后台前端 | **内嵌 SPA** | 一个镜像部署，同源免 CORS，版本一致 |
| Agent 容器 | **每 Agent 独立容器 + 可插拔 Runtime** | 隔离彻底，一个 Agent 失控不影响其他；Runtime 可切换（opencode/claude/codex/goose），共享 Sidecar + ACP Bridge |
| AionUI ↔ Agent | **Gateway 编排 + AionUI 直连 Agent** | Gateway 只负责鉴权、容器启停编排和地址分发，ACP 数据流由 AionUI 直连 Agent 容器，零转发延迟 |
| 跨容器 ACP | **AionUI → Gateway(编排) → 直连 Agent** | AionUI 请求 Gateway 获取连接地址后，通过 WebSocket 直接连接 Agent 容器的 ACP Bridge |
| 容器管理 | **Docker CLI（docker/podman 命令行）** | 起步阶段最简单直接，与现有 Gateway 实例管理方式一致，后期可迁移至 Docker API 或 Kubernetes |
| Agent 生命周期 | **24h 常驻 vs 按需启停** | 24h Agent（个人助理/部门化身）常驻；按需 Agent 空闲后自动停止，需要时秒起 |
| 存储 | **NFS + PostgreSQL** | 文件数据走 NFS 共享盘，元数据走 PG |
| ORM | **Drizzle ORM**（推荐） | 轻量、类型安全、PG 全特性支持 |

---

## 四、AionUI ↔ Agent 通信

### 通信场景总览

系统中存在三类通信场景：

| 场景 | 发起方 | 路径 | 协议 |
|------|--------|------|------|
| 用户交互 | 浏览器 | 浏览器 → Gateway → AionUI 工作区 | HTTP + WS |
| ACP 协作 | AionUI 工作区 | AionUI → Gateway(编排) → AionUI 直连 Agent 容器 | ACP over WebSocket |
| 管理通信 | Agent Sidecar | Sidecar → Gateway | HTTP (内部 API) |

### 设计理念：Gateway 编排，AionUI 直连

Gateway **不代理 ACP 数据流**，只负责编排（鉴权、容器启停、地址分发）。ACP 连接由 AionUI 工作区直连 Agent 容器，好处：

- **零转发延迟** — Gateway 不在数据面上，流式响应直通
- **Gateway 无状态** — 不持有 WebSocket 长连接，水平扩展无负担
- **协议纯粹** — ACP (JSON-RPC over WebSocket) 端到端，无需中间协议转换
- **故障隔离** — Gateway 重启不影响已建立的 ACP 连接

### 通信时序

```
AionUI 工作区                    Gateway                    Agent 容器
    │                              │                            │
    │── ① GET /api/agent/:id/     │                            │
    │         connect ────────────►│                            │
    │   Authorization: Bearer      │── 确保容器运行(冷启动) ────►│
    │         {userToken}          │   权限校验                  │
    │                              │                            │
    │◄── { url, token, protocol } ─│◄── 容器就绪 ──────────────│
    │                              │                            │
    │── ② WebSocket 直连 ─────────┼────────────────────────────►│
    │   ws://agent-xxx:3001/acp    │                            │
    │   Authorization: Bearer      │                            │
    │         {agentToken}         │                            │
    │                              │                            │
    │◄══════ ACP JSON-RPC 流式通信 ══════════════════════════════│
    │   (initialize → session/new  │                            │
    │    → session/prompt → ...)   │                            │
```

### 关键设计

| 设计点 | 说明 |
|--------|------|
| 通信路径 | ① AionUI → Gateway（编排请求）；② AionUI → Agent 容器（直连 ACP） |
| Gateway 职责 | 权限校验、容器地址解析、冷启动触发、签发短期连接令牌 |
| 容器地址解析 | Gateway 根据 Agent ID 查数据库获取容器名，Docker 内部 DNS 解析 |
| 冷启动 | 若目标 Agent 容器未运行，Gateway 先拉起容器（3-5s），再返回地址 |
| 连接令牌 | Gateway 签发短期 JWT（默认 5 分钟），Sidecar 校验后接受 WebSocket 连接 |
| 流式支持 | ACP 原生支持流式响应（session.update 事件），WebSocket 双向全双工天然匹配 |
| 安全 | Agent 容器不暴露外部端口，仅 Docker 内部网络可达；无合法令牌无法连接 |

### Gateway 编排 API 实现

`[src/routes/agent-connect.ts](src/routes/agent-connect.ts:247-302)` - Agent 连接编排 API

实现核心逻辑：
- **权限校验** - 检查用户是否有访问该 Agent 的权限
- **容器管理** - 通过 [`ensureAgentRunning()`](src/routes/agent-connect.ts:72-122) 确保容器运行（包括创建、启动、健康检查）
- **令牌签发** - 签发 5 分钟有效期的 JWT 令牌供 Sidecar 校验
- **地址返回** - 返回 WebSocket 直连地址（通过 Gateway 代理）

### Sidecar ACP Bridge 实现

`[agent-runtime/sidecar/acp-bridge.js](agent-runtime/sidecar/acp-bridge.js)` - ACP Bridge 实现

核心功能：
- **消息路由** - 三类消息分类路由：response（有 id）→ 发起方；notification（无 id 有 method）→ 按 session_id 路由；兜底 → 广播
- **session 绑定** - `ClientState.sessionId` 记录返回的 session_id，后续 notification 精准路由
- **写入串行化** - `writeQueue` + `drainQueue()` 防止多个客户端并发写入 stdio 交错
- **进程崩溃处理** - `restartVersion` + 指数退避重启，最多 3 次
- **bridge/status 通知** - 向客户端发送重启/就绪/错误状态

### bridge/status 通知协议

```
Runtime 进程重启时，ACP Bridge 向客户端发送的内部通知：

  { jsonrpc: '2.0', method: 'bridge/status',
    params: { status: 'restarting', reason: 'runtime exited with code 1' } }
  → 客户端应暂停发送请求，等待 ready

  { jsonrpc: '2.0', method: 'bridge/status',
    params: { status: 'ready', message: 'runtime restarted, please re-initialize' } }
  → 客户端应重新调用 initialize() + session/new()

  { jsonrpc: '2.0', method: 'bridge/status',
    params: { status: 'error', reason: '...' } }
  → 客户端应提示用户 Agent 不可用
```

### AionUI 端对接

AionUI 的 `AcpConnection`（本地通过 stdio JSON-RPC 与 opencode 通信）增加 WebSocket 传输，支持直连远程 Agent 容器：

```typescript
// AionUI src/process/agent/acp/AcpConnection.ts — 新增 connectRemote
async connectRemote(wsUrl: string, authToken: string): Promise<void> {
  this.backend = 'remote';

  // 1. 建立 WebSocket 连接
  const ws = new WebSocket(`${wsUrl}?token=${authToken}`);

  // 2. 替代 child.stdout 的消息处理 — 复用现有 handleMessage 逻辑
  ws.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString()) as AcpMessage;
    this.handleMessage(message);  // 与 stdio 模式完全一致
  });

  this.wsTransport = ws;

  // 3. 走现有的 initialize() 协议握手
  await this.initialize();
}
```

AionUI 串联编排流程：

```typescript
// AionUI 端调用入口
const conn = AcpConnection.connectViaGateway(
  'https://gw.example.com',   // Gateway URL
  agentId,                     // 目标 Agent
  userToken,                   // 用户身份令牌
);
// 内部: ① GET /api/agent/:id/connect → ② WebSocket 直连 → ③ ACP 协议握手
```

### 网络前提

直连方案要求 AionUI 容器和 Agent 容器在同一 Docker 网络内：

```
Docker 网络: aionui-network
  ├── gateway                   (Gateway)
  ├── aionui-gw-{userId}        (AionUI 工作区容器)
  └── agent-{tenantId}-{agentId} (Agent 容器)

AionUI ──ws://agent-xxx:3001/acp──→ Sidecar ──stdio──→ opencode acp
  ✅ 同一 Docker 网络内可直达，Agent 端口不暴露到宿主机
```

### 安全模型

```
AionUI → Gateway:   Bearer {userToken}      (用户 SSO 身份)
Gateway → AionUI:   { token: 'agentToken' }  (短期 JWT，5 分钟有效)
AionUI → Sidecar:   ws://...?token=agentToken (Sidecar 校验 JWT)
```

Sidecar 校验 `agentToken`（Gateway 用 JWT_SECRET 签发），验证通过才接受 WebSocket 连接。即使 Agent 容器的 3001 端口在 Docker 内部可达，没有合法令牌也无法连接。

### AionUI 企业模式配置

AionUI 通过环境变量启用远程 ACP 连接功能，无需修改代码即可切换为企业部署模式。

#### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AIONUI_ENTERPRISE_MODE` | 否 | `false` | 企业模式总开关。设为 `true` 启用企业特性 |
| `AIONUI_ENTERPRISE_REMOTE_RUNTIME` | 否 | `false` | 远程 ACP 运行时开关。需企业模式开启后生效 |
| `AIONUI_ENTERPRISE_GATEWAY_URL` | 否 | — | Gateway 地址（如 `https://gw.example.com`）。启用远程运行时时必填 |

#### 配置优先级

```
环境变量 (AIONUI_ENTERPRISE_*)  >  ProcessConfig (enterprise.*)  >  默认值 (false)
```

---

## 五、Agent 容器设计

### 设计理念

每个 Agent 运行在独立容器中，**容器编排层**（Docker Engine / Docker Compose）负责：
- 进程隔离与资源限制（CPU / 内存 / PID 数）
- 容器启停、崩溃自动重启
- 健康检查

容器内的 **Sidecar 进程**只负责业务逻辑（心跳、cron、通知、用量采集），不重复造轮子。

### 容器内部结构

#### stdio 模式（opencode / claude / goose / codex）

```
Agent 容器
┌──────────────────────────────────────────────────────┐
│                                                      │
│  Sidecar（轻量管理进程，前台运行）                      │
│  ├── 心跳上报（→ Gateway，每 30s）                     │
│  ├── cron 调度（通过内部通道触发 Runtime，不走 HTTP）   │
│  ├── 用量采集（聚合后批量上报 Gateway）                  │
│  ├── 通知推送（任务完成后推送至企微/钉钉/邮件）          │
│  └── 健康检查 HTTP（:3000，Docker 健康探针用）          │
│                                                      │
│  ACP Bridge（监听 :3001，stdio 模式专用）              │
│  ├── stdio ↔ WebSocket 双向桥接                       │
│  ├── JWT 令牌校验，拒绝未授权连接                       │
│  └── Runtime 可插拔（RUNTIME_CLI + RUNTIME_ARGS）     │
│                                                      │
│  Runtime 进程（后台运行，可插拔）                       │
│  ├── opencode acp / claude acp / goose acp / codex    │
│  ├── 模型调用 / MCP 工具 / 对话交互 / 文件读写         │
│  └── 通过 stdin/stdout JSON-RPC 与 ACP Bridge 通信     │
│                                                      │
│  /data/                                               │
│  ├── config.yaml           # Runtime 配置              │
│  ├── memory/              # 记忆存储                   │
│  │   ├── _index.yaml      # 记忆索引                   │
│  │   ├── conversations/   # 对话历史                   │
│  │   ├── knowledge/       # 积累的知识                 │
│  │   └── summary.md       # 记忆摘要                   │
│  └── workspace/           # Agent 工作目录              │
│                                                      │
│  /skills/                  # Skill 只读挂载             │
│  /config/base.yaml         # 企业级基础配置             │
└──────────────────────────────────────────────────────┘

客户端 ──WebSocket (ACP JSON-RPC)──→ ACP Bridge :3001 ──stdio──→ Runtime
```

#### gateway 模式（OpenClaw）

```
Agent 容器
┌──────────────────────────────────────────────────────┐
│                                                      │
│  Sidecar（轻量管理进程，前台运行）                      │
│  ├── 心跳上报（→ Gateway，每 30s）                     │
│  ├── 健康检查 HTTP（:3000，Docker 健康探针用）          │
│  └── 进程管理（spawn、崩溃重启）                       │
│                                                      │
│  Runtime 进程（自带 WebSocket 服务）                   │
│  ├── openclaw gateway --port 18789                    │
│  ├── 自带认证（设备身份 + 签名 + token）               │
│  ├── 自带会话管理、消息路由                             │
│  └── 直接暴露 WebSocket 端口，客户端直连               │
│                                                      │
│  /data/ ...                                          │
└──────────────────────────────────────────────────────┘

客户端 ──WebSocket (OpenClaw 原生协议)──→ Runtime :18789
Sidecar 不在数据面上，只做进程管理
```

### Transport 模式

| 模式 | 适用 Runtime | Sidecar 职责 | 对外协议 | 对外端口 |
|------|-------------|-------------|---------|---------|
| **stdio** | opencode, claude, goose, codex | spawn + stdio ↔ WebSocket 桥接 + JWT | ACP (JSON-RPC 2.0) | 3001 |
| **gateway** | openclaw | spawn + 健康检查（不在数据面） | Runtime 原生协议 | 18789 |

由环境变量 `TRANSPORT_MODE` 控制，Dockerfile 中设定。

### Sidecar 实现

`[agent-runtime/sidecar/agent-sidecar.js](agent-runtime/sidecar/agent-sidecar.js)` - Sidecar 主逻辑

主要职责：
- **心跳上报** - 定期向 Gateway 发送状态和指标
- **ACP Bridge** - 管理 opencode acp 和 WebSocket 桥接
- **定时任务** - 接收 Gateway 下发的 cron 配置，本地执行
- **用量采集** - 收集 opencode 的 token 使用情况
- **通知推送** - 对接企业通知渠道

### Gateway Container Manager

通过 Docker CLI 管理 Agent 容器：

```typescript
// 容器创建逻辑位于 [src/routes/agent-connect.ts](src/routes/agent-connect.ts:127-163)
// 包含资源限制、网络配置、环境变量注入等
```

### 容器生命周期

```
Agent 创建/发布
      │
      ▼
┌─────────────┐    创建容器     ┌──────────┐
│   draft     │ ──────────────► │ starting │
└─────────────┘                 └────┬─────┘
                                     │ Sidecar 上报 ready
                                     ▼
                                ┌──────────┐
                          ┌────►│ running  │◄──── 正常心跳
                          │     └────┬─────┘
                          │          │
                    重启成功     心跳超时 / 异常
                          │          │
                          │          ▼
                          │     ┌────────────┐
                          └─────│ unhealthy  │
                                └────┬───────┘
                                     │
                          ┌──────────┼──────────┐
                          │          │          │
                     重启 < 3次   重启 ≥ 3次   用户停止
                          │          │          │
                          ▼          ▼          ▼
                     ┌─────────┐ ┌───────┐ ┌─────────┐
                     │restarting│ │ error │ │ stopped │
                     └─────────┘ └───────┘ └─────────┘
```

### 24h 常驻 vs 按需启停

两种策略用同一个镜像，区别在 Gateway 层的管理行为：

| | 24h 常驻 | 按需启停 |
|---|---|---|
| **适用场景** | 个人助理、部门数字化身 | 用户自建的工作流 Agent |
| **创建时** | 立即启动容器 | 不启动，记录配置 |
| **收到请求时** | 已在运行，直接响应 | 冷启动容器（~3-5s），响应请求 |
| **空闲时** | 永不主动停止 | 30 分钟无活跃 → 自动停止容器 |
| **异常时** | 自动重启 | 如无活跃请求 → 直接停止 |
| **资源规格** | 0.25C / 256MB（待机为主） | 0.5C / 512MB（按需） |

### opencode serve 能力补齐

opencode 已具备模型调用、MCP 工具、对话交互、文件读写等核心能力。
Sidecar 补齐以下缺口：

| 能力 | opencode 现状 | Sidecar 补齐方式 |
|------|-------------|-----------------|
| 定时触发 | 请求驱动，无 cron | Sidecar 内置 cron，通过内部通道发 JSON-RPC 触发 opencode |
| 长期记忆 | 会话内上下文，无跨会话持久化 | Agent 目录下文件存储，通过 MCP 工具读写 |
| 主动通知 | 只能被动响应 | Sidecar 对接消息通道 |
| 用量上报 | 无 | Sidecar 采集后上报 Gateway |
| 心跳健康 | 无 | Sidecar 定期上报 Gateway |

### 资源规划（300 人企业参考）

```
300 人企业，高峰 500 Agent

实际运行分布：
┌─────────────────────────────────────────┐
│  24h 常驻容器：~320 个                    │
│    · 300 个人助理 × (0.25C / 256MB)      │
│    · ~20 部门数字化身 × (0.5C / 512MB)    │
│    日常实际消耗：~10C / ~60GB             │
│                                         │
│  按需容器：~180 个（注册），同时在线 ~50    │
│    · 50 活跃 × (0.5C / 512MB)            │
│    日常实际消耗：~25C / ~25GB             │
│                                         │
│  基础设施：                               │
│    · Gateway × 2（HA）：4C / 8GB         │
│    · PostgreSQL：4C / 16GB               │
│    · NFS / 监控 / 日志：4C / 8GB          │
│                                         │
│  ═══════════════════════════════════════ │
│  日常总计：~25C / ~100GB                  │
│  峰值总计：~120C / ~130GB                 │
│                                         │
│  推荐配置：                               │
│    3 × 16C/64GB 节点 = 48C/192GB        │
│    留有充足余量，支持突发和扩容             │
└─────────────────────────────────────────┘
```

---

## 六、存储架构

### 职责划分

```
NFS 共享盘 — 文件数据（大、可变、运行时需要）
├── Agent 运行时数据（配置、记忆、工作文件）
├── Skill 定义文件
├── 知识库文档
├── 用户工作目录
├── opencode 配置文件
└── AionUI 配置文件

PostgreSQL — 元数据（小、结构化、Gateway 管理用）
├── 用户账号 & 认证信息
├── 实例 & Agent 容器状态
├── RBAC 权限关系
├── Agent / Skill 注册元数据（名称、归属、状态）
├── 定时任务定义 & 执行记录
├── Token 用量统计
├── 模型配置
├── MCP 接口配置
├── 通知渠道配置
└── 知识库注册信息

二者通过 NFS 路径关联：PG 中存路径，NFS 上存文件。
```

### NFS 目录结构

```
{nfs_root}/tenants/{tenantId}/
├── configs/                              # 企业级配置
│   ├── models.yaml                       # 模型配置（仅 Gateway 读取，不挂给用户）
│   └── opencode-base.yaml                # opencode 基础配置模板
│
├── agents/{agentId}/                     # Agent 库
│   ├── agent.yaml                        # Agent 定义（prompt、参数）
│   ├── skills/                           # 绑定的 Skill 文件
│   ├── memory/                           # 记忆存储
│   │   ├── _index.yaml                   # 记忆索引（避免遍历）
│   │   ├── conversations/                # 对话历史
│   │   ├── knowledge/                    # 积累的知识
│   │   └── summary.md                    # 记忆摘要
│   ├── workspace/                        # Agent 工作目录
│   └── opencode.yaml                     # opencode 专属配置
│
├── skills/{skillId}/                     # Skill 库（独立于 Agent，可复用）
│   ├── skill.yaml                        # Skill 定义
│   └── templates/                        # 提示词模板
│
├── knowledge/{kbId}/                     # 知识库
│   ├── meta.yaml
│   └── documents/
│
├── users/{userId}/                       # 用户数据
│   ├── workspace/                        # AionUI 工作区数据
│   ├── opencode.yaml                     # 个人 opencode 配置（继承企业模板）
│   └── preferences.yaml                  # 个人偏好
│
└── departments/{deptId}/                 # 部门数据
    └── workspace/                        # 部门共享空间
```

### 挂载策略

**AionUI 工作区容器（员工日常使用）：**

```
-v users/{userId}/workspace     → /data
-v users/{userId}/opencode.yaml → /config/opencode.yaml
-v skills/                      → /skills (只读)
```

**Agent 容器（每个 Agent 独立容器）：**

```
-v agents/{agentId}/            → /data
-v configs/opencode-base.yaml   → /config/base.yaml (只读)
-v skills/                      → /skills (只读)

# 部门 Agent 额外挂载
-v departments/{deptId}/        → /shared (部门 Agent 专用)
```

### NFS 注意事项

| 问题 | 应对策略 |
|------|---------|
| 并发写入冲突 | 设计上避免：每个 Agent 独立容器 + 独立目录，天然隔离 |
| 大量小文件读取延迟 | Agent 目录中设 `_index.yaml` 索引文件，避免遍历 |
| NFS 挂载失败 | Sidecar 启动时检查挂载点可用性，不可用则上报 Gateway 等待重试 |
| 性能优化（后期） | 读多写少的数据（Skill 定义、知识库）可做容器内本地缓存 |

---

## 七、认证与权限

### SSO 扩展

```
现有：GitHub / Google / Zhimi CAS (OAuth2)
新增：SAML 2.0（企业常见）
新增：OIDC（通用标准）
新增：LDAP/AD 直连（传统企业）
```

### 角色体系 (RBAC)

| 角色 | 权限范围 |
|------|---------|
| `super_admin` | 平台超管，管理多租户 |
| `tenant_admin` | 企业管理员，管理本企业全部资源 |
| `dept_admin` | 部门管理员，管理本部门资源 |
| `member` | 普通员工，使用工作区和被授权的 Agent |

### 内部通信鉴权

Gateway 与 Sidecar 之间的心跳、配置下发等内部通信使用 **预共享密钥**（Gateway Secret），通过环境变量注入容器，不走用户认证链路。

---

## 八、Gateway API 设计

Gateway 不再仅做代理，需要提供自己的管理 API：

```
/api/
├── auth/                            # 认证
│   ├── POST   /login
│   ├── POST   /logout
│   └── GET    /status
│
├── user/                            # 员工端
│   ├── GET    /workspace            # 工作区状态 & 连接信息
│   ├── GET    /agents               # 我的 Agent 列表（含容器状态）
│   ├── CRUD   /agents/:id           # Agent 管理
│   ├── POST   /agents/:id/start     # 启动 Agent 容器
│   ├── POST   /agents/:id/stop      # 停止 Agent 容器
│   ├── POST   /agents/:id/restart   # 重启 Agent 容器
│   ├── GET    /skills               # 可用 Skill 列表
│   ├── CRUD   /skills/:id           # Skill 管理
│   ├── CRUD   /schedules            # 我的定时任务
│   ├── GET    /usage                # 我的 Token 用量
│   └── GET    /knowledge            # 我的知识库
│
├── admin/                           # 管理端
│   ├── /tenants                     # 租户管理（super_admin）
│   ├── /users                       # 用户管理
│   ├── /departments                 # 部门管理
│   ├── /agents                      # Agent 全局管理
│   ├── /skills                      # Skill 全局管理
│   ├── /resources                   # 资源监控（实例 & Agent 容器状态）
│   ├── /usage                       # Token 用量统计（按人/部门/Agent）
│   ├── /schedules                   # 定时任务全局视图
│   ├── /mcp-endpoints               # MCP 接口管理
│   ├── /knowledge-bases             # 知识库管理
│   ├── /model-configs               # 模型配置管理
│   └── /notification-channels       # 通知渠道管理
│
├── internal/                        # 内部接口（Sidecar → Gateway）
│   ├── POST   /heartbeat            # Sidecar 心跳上报
│   ├── POST   /usage/report         # 用量数据上报
│   └── POST   /schedule/result      # 定时任务执行结果上报
│
├── agent/                           # Agent 编排（AionUI → Gateway 获取直连地址）
│   └── GET    /:id/connect          # 返回 Agent 直连地址 + 短期令牌
│
└── proxy/                           # 代理（现有逻辑）
    └── /*                           # → 用户 AionUI 实例
```

---

## 九、PostgreSQL 数据模型

### ER 关系总览

```
tenants ──────────────────────────────────────────────────┐
  │                                                       │
  ├── departments ──── (递归 parent_id，支持多级部门树)     │
  │     ├── users                                         │
  │     └── dept agents (via agents.owner_type='dept')    │
  │                                                       │
  ├── users ──────────────────────────────────────────────┤
  │     ├── personal agents (via agents.owner_type='user')│
  │     └── token_usage                                   │
  │                                                       │
  ├── agents ──── agent_skills ──── skills                │
  │     ├── schedules → schedule_logs                     │
  │     ├── agent_mcp_endpoints ──── mcp_endpoints        │
  │     ├── agent_knowledge_bases ── knowledge_bases       │
  │     └── agent_notification_channels ── notif_channels │
  │                                                       │
  ├── instances (AionUI 工作区容器)                        │
  ├── model_configs                                       │
  └── token_usage                                         │
```

> **变更说明**：去掉 `runtimes` 表。每个 Agent 独立容器，容器信息直接挂到 `agents` 表上，1:1 关系无需额外表。

### 完整表结构

详见 `docs/database-schema.sql`（此处省略完整表结构，请参考数据库迁移文件）

---

## 十、项目结构

```
aionui-gateway/
├── src/                              # 后端 (TypeScript, Express)
│   ├── index.ts                      # 入口
│   ├── config/                       # 配置管理
│   │   └── [index.ts](src/config/index.ts) - 配置定义
│   ├── auth/                         # SSO / OAuth2 / SAML / OIDC
│   ├── database/                     # PostgreSQL (Drizzle ORM)
│   │   ├── schema/                   # 表定义
│   │   └── migrations/               # 数据库迁移
│   ├── container/                    # Agent 容器管理
│   │   ├── agent-container-manager.ts # 容器创建/销毁/健康检查
│   │   └── lifecycle-policies.ts     # 24h 常驻 vs 按需启停策略
│   ├── instance/                     # AionUI 工作区容器管理
│   ├── scheduler/                    # 定时任务调度
│   ├── middleware/                   # 认证守卫、RBAC 权限
│   ├── proxy/                        # 反向代理 (HTTP + WS)
│   │   └── [index.ts](src/proxy/index.ts) - HTTP + WebSocket 代理
│   ├── routes/                       # 路由
│   │   ├── [gateway.ts](src/routes/gateway.ts) - 登录页 / OAuth 回调
│   │   ├── [user.ts](src/routes/user.ts) - /api/user/* 员工端 API
│   │   ├── [admin.ts](src/routes/admin.ts) - /api/admin/* 管理端 API
│   │   ├── [internal.ts](src/routes/internal.ts) - /api/internal/* Sidecar 上报接口
│   │   └── [agent-connect.ts](src/routes/agent-connect.ts) - Agent 编排 API
│   └── types/                        # TypeScript 类型定义
│
├── admin/                            # 管理后台前端 (内嵌 SPA)
│   ├── src/
│   ├── dist/                         # 构建产物
│   ├── package.json
│   └── vite.config.ts
│
├── agent-runtime/                     # Agent 容器（可插拔 Runtime + Transport 模式）
│   ├── sidecar/
│   │   ├── [agent-sidecar.js](agent-runtime/sidecar/agent-sidecar.js) - Sidecar（心跳/健康检查/Transport 调度）
│   │   └── [acp-bridge.js](agent-runtime/sidecar/acp-bridge.js) - ACP Bridge（stdio 模式专用）
│   ├── images/                        # 各 Runtime 镜像定义
│   │   ├── opencode/Dockerfile        # opencode acp         (stdio)
│   │   ├── claude/Dockerfile          # claude acp           (stdio)
│   │   ├── codex/Dockerfile           # codex                (stdio)
│   │   ├── goose/Dockerfile           # goose acp            (stdio)
│   │   └── openclaw/Dockerfile        # openclaw gateway     (gateway)
│   ├── [index.js](agent-runtime/index.js) - Sidecar 入口
│   ├── [entrypoint.sh](agent-runtime/entrypoint.sh) - 容器启动脚本
│   └── package.json
│
├── docker-compose.yaml               # 开发/部署编排
├── Dockerfile                        # Gateway 镜像
└── package.json
```

---

## 十一、演进路径

### Phase 1 — 基础企业化

- 多租户数据模型（PG + Drizzle ORM）
- RBAC 角色体系
- 管理 API 骨架
- Agent / Skill CRUD
- 统一模型配置 & 挂载机制

### Phase 2 — Agent 容器化 + ACP 直连 ✅ 已完成

- Agent 容器镜像构建（可插拔 Runtime: opencode/claude/codex/goose + Sidecar + ACP Bridge）
- Sidecar ACP Bridge（stdio ↔ WebSocket 桥接，Runtime 可插拔）
- Gateway 编排 API（鉴权 + 容器启停 + 直连地址分发）
- AionUI AcpConnection WebSocket 传输（直连远程 Agent）
- Gateway Container Manager（Docker CLI 管理）
- Agent 生命周期管理（24h 常驻 / 按需启停 / 空闲回收）
- Sidecar 心跳上报 & 用量采集
- 定时任务调度（Gateway 下发 → Sidecar 执行）
- Token 用量统计

### Phase 3 — 管理平台

- 管理后台前端（内嵌 SPA）
- 资源监控 Dashboard（容器状态、资源使用）
- MCP 接口市场
- 知识库管理
- 通知渠道对接
- Agent 发布 & 分发流程

---

## 十二、待讨论事项

以下问题在后续讨论中逐步明确：

1. **消息通知优先级** — 企业微信 / 钉钉 / 邮件，首先支持哪个
2. **Agent 记忆的索引机制** — `_index.yaml` 文件结构的具体设计
3. **多 Gateway 实例高可用** — 负载均衡、Session 共享方案
4. **连接令牌有效期** — Gateway 签发的 JWT 有效期（当前默认 5 分钟），是否需要刷新机制
5. **Agent 版本管理** — 是否需要版本快照和回滚
6. **NFS 高可用** — 单 NFS 挂掉则所有 Agent 容器不可用的应对方案
7. **API Key 加密方案** — `model_configs.api_key_encrypted` 的加密密钥管理（KMS vs 应用层 AES）