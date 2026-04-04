# agent-runtime

AionUI Agent Runtime — 可插拔的 Agent 执行容器。

每个 Agent 运行在独立容器中，容器内的 **Sidecar** 负责基础设施（心跳、健康检查、进程管理）。根据 Runtime 类型，通过不同的 **Transport 模式** 对外暴露服务。

## 目录结构

```
agent-runtime/
├── sidecar/
│   ├── agent-sidecar.js      # Sidecar 主逻辑（心跳、健康检查、Transport 模式调度）
│   └── acp-bridge.js         # ACP Bridge（stdio ↔ WebSocket，仅 stdio 模式使用）
├── images/                    # 各 Runtime 的镜像定义
│   ├── opencode/Dockerfile   # opencode acp       (stdio)
│   ├── claude/Dockerfile     # claude acp         (stdio)
│   ├── codex/Dockerfile      # codex              (stdio)
│   ├── goose/Dockerfile      # goose acp          (stdio)
│   └── openclaw/Dockerfile   # openclaw gateway   (gateway)
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

| Runtime | Transport | CLI | 参数 | 对外端口 |
|---------|-----------|-----|------|---------|
| **opencode** | stdio | `opencode` | `acp` | 3001 |
| **claude** | stdio | `claude` | `acp` | 3001 |
| **codex** | stdio | `npx` | `@anthropic-ai/codex-acp` | 3001 |
| **goose** | stdio | `goose` | `acp` | 3001 |
| **openclaw** | gateway | `openclaw` | `gateway --port 18789` | 18789 |

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
3. **Sidecar 职责单一** — 进程管理 + 心跳 + 健康检查，不干预数据面
4. **镜像独立构建** — 各 Dockerfile 独立维护，互不干扰
5. **ACP Bridge 仅 stdio 使用** — gateway 模式不经过 ACP Bridge
6. **ACP 协议参考** — 涉及 ACP 协议细节（方法、参数、消息格式、流式通知等）时，查阅 `../AionUI/` 项目中的实现（`src/common/types/acpTypes.ts`、`src/process/agent/acp/`），不凭记忆猜测

## 镜像构建

所有 Dockerfile 统一包含：
- **中国镜像源** — npm: `registry.npmmirror.com`，apt: `mirrors.aliyun.com`
- **CRLF 修复** — `sed -i 's/\r$//' /entrypoint.sh`（Windows 开发环境产生的 CRLF 换行符）
- **健康检查** — Sidecar 内置 HTTP `:3000/health`（由 agent-sidecar.js 提供）
