# agent-runtime

AionUI Agent Runtime — 可插拔的 Agent 执行容器。

每个 Agent 运行在独立容器中，容器内的 **Sidecar** 负责基础设施（注册/注销、心跳、健康检查、能力发现、配置热更新、进程管理）。根据 Runtime 类型，通过不同的 **Transport 模式** 对外暴露服务。

## 目录结构

```
agent-runtime/
├── sidecar/
│   ├── agent-sidecar.js      # Sidecar 主逻辑（注册/注销、心跳、健康检查、能力发现、配置热更新）
│   └── acp-bridge.js         # ACP Bridge（stdio ↔ WebSocket，仅 stdio 模式使用）
├── images/                    # 各 Runtime 的镜像定义
│   ├── opencode/Dockerfile   # opencode acp       (stdio)
│   ├── claude/Dockerfile     # claude acp         (stdio)
│   ├── codex/Dockerfile      # codex              (stdio)
│   ├── goose/Dockerfile      # goose acp          (stdio)
│   └── openclaw/Dockerfile   # openclaw gateway   (gateway)
├── doc/                       # 文档
│   ├── sidecar-gateway-interface.md   # Sidecar ↔ Gateway 接口契约 v1
│   └── heartbeat-and-healthcheck.md   # 心跳与健康检查详细说明
├── index.js                   # Sidecar 入口
├── entrypoint.sh              # 容器启动脚本
├── package.json
└── test-acp.mjs               # ACP 协议测试脚本
```

## Transport 模式

Sidecar 根据 `TRANSPORT_MODE` 环境变量选择通信方式：

### stdio 模式（默认）

适用于 stdin/stdout JSON-RPC 通信的 Runtime（opencode、claude、goose、codex）。

```
客户端 ──WebSocket (ACP JSON-RPC)──→ ACP Bridge :3001 ──stdio──→ Runtime
```

- Sidecar 启动 ACP Bridge，spawn Runtime 进程
- ACP Bridge 桥接 stdio ↔ WebSocket，JWT 校验，消息路由
- 外部客户端通过 ACP 协议（JSON-RPC 2.0）连接 `:3001`

### gateway 模式

适用于自带 WebSocket 服务的 Runtime（OpenClaw）。

```
客户端 ──WebSocket (Runtime 原生协议)──→ Runtime :18789
Sidecar 不在数据面上，只做 spawn + 健康检查 + 心跳上报
```

- Sidecar 只做进程管理和心跳，不做协议桥接
- 客户端直连 Runtime 的 WebSocket 端口
- 不需要 ACP Bridge

### 对比

| | stdio | gateway |
|---|---|---|
| **Sidecar 职责** | spawn + stdio 桥接 + JWT | spawn + 健康检查 |
| **对外协议** | ACP (JSON-RPC 2.0) | Runtime 原生协议 |
| **对外端口** | 3001 | 由 Runtime 决定（如 18789） |
| **ACP Bridge** | 需要 | 不需要 |
| **适用** | opencode, claude, goose, codex | openclaw |

## 支持的 Runtime

| Runtime | Transport | CLI | 参数 | 对外端口 | 镜像名 |
|---------|-----------|-----|------|---------|--------|
| **opencode** | stdio | `opencode` | `acp` | 3001 | `aionui-runtime-opencode` |
| **claude** | stdio | `claude` | `acp` | 3001 | `aionui-runtime-claude` |
| **codex** | stdio | `npx` | `@anthropic-ai/codex-acp` | 3001 | `aionui-runtime-codex` |
| **goose** | stdio | `goose` | `acp` | 3001 | `aionui-runtime-goose` |
| **openclaw** | gateway | `openclaw` | `gateway --port 18789` | 18789 | `aionui-runtime-openclaw` |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TRANSPORT_MODE` | `stdio` | `stdio` 或 `gateway` |
| `RUNTIME_CLI` | `opencode` | Runtime CLI 命令（Dockerfile 设定） |
| `RUNTIME_ARGS` | `acp` | Runtime CLI 参数（Dockerfile 设定） |
| `AGENT_ID` | `default` | Agent 标识 |
| `WORK_DIR` | `/workspace` | Agent 工作目录 |
| `GATEWAY_URL` | `http://gateway:3000` | Gateway 地址 |
| `GATEWAY_SECRET` | （空） | Gateway 通信密钥 |
| `HEARTBEAT_INTERVAL` | `30000` | 心跳间隔（ms） |
| `HEALTH_PORT` | `3000` | Sidecar HTTP 端口（/health、/info、/config-reload） |
| `ACP_PORT` | `25808` | ACP Bridge 端口（stdio 模式） |
| `JWT_SECRET` | `dev-secret` | JWT 密钥（stdio 模式） |

## 配置注入

Runtime 容器按需启动，配置文件由 Gateway 生成并通过 Docker volume 挂载注入。详见 [agent-runtime-config.md](agent-runtime-config.md)。

## 扩展新 Runtime

在 `images/` 下创建目录，编写 Dockerfile：

- **stdio 模式**：设置 `RUNTIME_CLI` + `RUNTIME_ARGS`，暴露 `:3001`
- **gateway 模式**：设置 `TRANSPORT_MODE=gateway` + `RUNTIME_CLI` + `RUNTIME_ARGS`，暴露 Runtime 自身端口

所有 Dockerfile 共享同一套 sidecar 代码（`sidecar/` 目录），只改 CLI 安装和环境变量。

## 设计规则

1. **Runtime 可插拔** — `RUNTIME_CLI` / `RUNTIME_ARGS` 切换执行层，Sidecar 代码零修改
2. **Transport 可选** — stdio 模式桥接 ACP，gateway 模式直连 Runtime，不强制统一协议
3. **Sidecar 职责单一** — 进程管理 + 注册/注销 + 心跳 + 健康检查 + 能力发现 + 配置热更新，不干预数据面
4. **镜像独立构建** — 各 Dockerfile 独立维护，互不干扰
5. **ACP Bridge 仅 stdio 使用** — gateway 模式不经过 ACP Bridge
6. **ACP 协议参考** — 涉及 ACP 协议细节（方法、参数、消息格式、流式通知等）时，查阅 `../AionUI/` 项目中的实现（`src/common/types/acpTypes.ts`、`src/process/agent/acp/`），不凭记忆猜测

## 镜像命名规范

所有 Agent Runtime 镜像统一命名格式：

```
aionui-runtime-{type}:latest
```

| Runtime | 镜像名 | 构建命令 |
|---------|--------|----------|
| opencode | `aionui-runtime-opencode:latest` | `docker build -t aionui-runtime-opencode:latest -f images/opencode/Dockerfile .` |
| claude | `aionui-runtime-claude:latest` | `docker build -t aionui-runtime-claude:latest -f images/claude/Dockerfile .` |
| codex | `aionui-runtime-codex:latest` | `docker build -t aionui-runtime-codex:latest -f images/codex/Dockerfile .` |
| goose | `aionui-runtime-goose:latest` | `docker build -t aionui-runtime-goose:latest -f images/goose/Dockerfile .` |
| openclaw | `aionui-runtime-openclaw:latest` | `docker build -t aionui-runtime-openclaw:latest -f images/openclaw/Dockerfile .` |

> **注意**：`aionui:latest` 是 AionUI 主应用镜像（由 `instance/manager.ts` 管理），与 Runtime 镜像是两套不同的东西，不要混淆。

## 镜像构建

所有 Dockerfile 统一包含：
- **中国镜像源** — npm: `registry.npmmirror.com`，apt: `mirrors.aliyun.com`
- **CRLF 修复** — `sed -i 's/\r$//' /entrypoint.sh`（Windows 开发环境产生的 CRLF 换行符）
- **健康检查** — Sidecar 内置 HTTP `:3000/health`（由 agent-sidecar.js 提供）
- **构建上下文** — 在 `agent-runtime/` 目录下执行构建（注意结尾的 `.`），不在 `images/` 子目录内构建

## Sidecar ↔ Gateway 接口契约

Sidecar 遵循 **接口契约 v1**（详见 [doc/sidecar-gateway-interface.md](doc/sidecar-gateway-interface.md)），使 agent-runtime 可对接任意符合契约的 Gateway 实现。

### Sidecar → Gateway（主动上报）

| 接口 | 方法 | 触发时机 | 认证 |
|------|------|---------|------|
| `/api/internal/register` | POST | 启动后，Runtime 就绪时 | Bearer `GATEWAY_SECRET` |
| `/api/internal/heartbeat` | POST | 周期性，默认每 30s | Bearer `GATEWAY_SECRET` |
| `/api/internal/deregister` | POST | 收到 SIGTERM/SIGINT 时 | Bearer `GATEWAY_SECRET` |

- 注册重试 3 次（指数退避），失败不阻塞启动
- 注销单次尝试 + 5s 超时，失败不阻塞关停
- 心跳失败仅打印日志，不影响运行

### Gateway → Sidecar（被动查询）

| 接口 | 方法 | 端口 | 认证 | 用途 |
|------|------|------|------|------|
| `/health` | GET | `HEALTH_PORT`(3000) | 无 | 存活探测（Docker HEALTHCHECK / K8s probe） |
| `/info` | GET | `HEALTH_PORT`(3000) | 无 | 能力发现（版本、transport、capabilities） |
| `/config-reload` | POST | `HEALTH_PORT`(3000) | Bearer `GATEWAY_SECRET` | 配置热更新（重启 Runtime 进程） |

### 配置热更新

Gateway 更新宿主机配置文件后，调用 `POST /config-reload` 通知 Sidecar 重启 Runtime：

```
1. Gateway 写入新 opencode.json（bind mount 自动同步到容器内）
2. Gateway POST :3000/config-reload (Bearer token)
3. Sidecar 停止旧 Runtime → 启动新 Runtime（加载新配置）
4. 客户端 WebSocket 断开 → 重连后重新 initialize + session/new
```

**副作用**：Runtime 进程重启，当前 session 失效（对话上下文丢失），workspace 代码变更保留。

### Metrics 采集

心跳携带真实运行指标：

| 指标 | 采集方式 | 说明 |
|------|---------|------|
| `cpu` | `process.cpuUsage()` 差值 | CPU 使用率（%） |
| `memory` | `process.memoryUsage().rss` | RSS 内存（bytes） |
| `memoryDetail` | `process.memoryUsage()` | rss/heapTotal/heapUsed/external |
| `requests` | HTTP 请求计数器 | Sidecar HTTP 端口累计请求数 |
| `uptime` | `process.uptime()` | 进程运行时长（秒） |
| `loadAvg` | `os.loadavg()` | 系统 1/5/15 分钟负载 |

### 优雅降级

Sidecar **不依赖 Gateway 存在**也能独立运行。注册/心跳/注销均为 best-effort，Gateway 不实现或不可达时 Sidecar 照常工作。

### 生命周期

```
容器启动
  │
  ▼
sidecar.start()
  ├── startTransport()            ← 启动 Runtime
  ├── register()                  ← 向 Gateway 注册（best-effort）
  ├── startHeartbeat()            ← 心跳定时器
  └── startHealthServer()         ← HTTP :3000（/health + /info + /config-reload）
  │
  ▼ 运行中
  │  ├── 每 30s POST heartbeat
  │  ├── /health 响应探测
  │  ├── /info 响应发现查询
  │  └── /config-reload 触发热更新 → reloadRuntime()
  │
  ▼ SIGTERM
  │
sidecar.stop()
  ├── deregister()                ← 向 Gateway 注销（best-effort）
  ├── clearHeartbeat
  ├── closeHealthServer
  └── stopTransport
```
