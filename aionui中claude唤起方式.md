# AionUi 中 Claude Code 唤起方式调研

## 概述

AionUi 是一个基于 Electron 的 AI 编码助手客户端，支持多种编码 Agent（Claude Code、Codex、Gemini、Qwen 等）。所有 Agent 通过统一的 **ACP (Agent Communication Protocol)** 协议与 AionUi 通信，ACP 是基于 JSON-RPC 的双向通信协议。

Claude Code **不是直接调用**，而是通过 `@zed-industries/claude-agent-acp` npm 桥接包中转，该包将 ACP JSON-RPC 协议翻译为 Claude Code 内部协议。

---

## 调用链路

```
用户 (Electron Renderer UI)
  │
  │  Electron IPC Bridge (ipcBridge.acpConversation.responseStream)
  ▼
AcpAgentManager (src/process/task/AcpAgentManager.ts)
  │
  ▼
AcpAgent (src/process/agent/acp/index.ts) — 协议层：init, auth, session, prompt
  │
  ▼  JSON-RPC over stdio / WebSocket
  │
AcpConnection (src/process/agent/acp/AcpConnection.ts) — 传输层：spawn 子进程 + 消息收发
  │
  ├── 本地模式 (stdio) ── spawn("npx", ["--yes", "@zed-industries/claude-agent-acp@0.21.0"])
  │                              │
  │                              ▼
  │                        claude-agent-acp bridge (npm 包)
  │                              │
  │                              ▼
  │                        Claude Code CLI
  │
  └── 远程模式 (WebSocket) ── AcpWsTransport ── 远程 ACP Bridge Container
```

---

## 1. Claude Code 的 spawn 方式

### 桥接包定义

文件：`src/common/types/acpTypes.ts`

```typescript
export const CLAUDE_ACP_BRIDGE_VERSION = '0.21.0';
export const CLAUDE_ACP_NPX_PACKAGE = `@zed-industries/claude-agent-acp@${CLAUDE_ACP_BRIDGE_VERSION}`;
```

### 实际 spawn 调用

文件：`src/process/agent/acp/acpConnectors.ts`

```typescript
// 连接 Claude 的入口
export function connectClaude(workingDir: string, hooks: NpxConnectHooks): Promise<void> {
  return connectNpxBackend({
    backend: 'claude',
    npxPackage: CLAUDE_ACP_NPX_PACKAGE,  // '@zed-industries/claude-agent-acp@0.21.0'
    prepareFn: prepareClaude,
    workingDir,
    ...hooks,
  });
}

// 底层 spawn 实现
export function spawnNpxBackend(
  backend: string,
  npxPackage: string,
  npxCommand: string,
  cleanEnv: Record<string, string | undefined>,
  workingDir: string,
  isWindows: boolean,
  preferOffline: boolean,
  { extraArgs = [], detached = false }
): SpawnResult {
  const spawnArgs = ['--yes', ...(preferOffline ? ['--prefer-offline'] : []), npxPackage, ...extraArgs];
  const child = spawn(effectiveCommand, spawnArgs, {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],  // stdin/stdout/stderr 全部管道化
    env: cleanEnv,
    shell: isWindows,
    detached,
  });
  return { child, isDetached: detached };
}
```

最终等价于执行：

```bash
npx --yes @zed-industries/claude-agent-acp@0.21.0
```

### 两阶段重试策略

文件：`src/process/agent/acp/acpConnectors.ts`

- **Phase 1**：`npx --yes --prefer-offline @zed-industries/claude-agent-acp@0.21.0`（优先使用缓存，快速启动）
- **Phase 2**：Phase 1 失败则去掉 `--prefer-offline` 重新下载
- 额外处理：npm 缓存损坏时自动 `npm cache clean --force` 后重试

---

## 2. 环境准备（清理 Electron 污染）

文件：`src/process/agent/acp/acpConnectors.ts`

```typescript
export function prepareCleanEnv(): Record<string, string | undefined> {
  const cleanEnv = getEnhancedEnv();
  delete cleanEnv.NODE_OPTIONS;       // 移除 Electron 注入的变量
  delete cleanEnv.NODE_INSPECT;
  delete cleanEnv.NODE_DEBUG;
  delete cleanEnv.CLAUDECODE;          // 防止嵌套 session 检测
  // 移除所有 npm_lifecycle_* 变量
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith('npm_')) {
      delete cleanEnv[key];
    }
  }
  return cleanEnv;
}
```

关键点：清除 `CLAUDECODE` 环境变量，防止 `claude-agent-sdk` 检测到嵌套会话。

---

## 3. ACP 协议通信（JSON-RPC over stdio）

### 写入消息（→ 子进程 stdin）

文件：`src/process/agent/acp/utils.ts`

```typescript
export function writeJsonRpcMessage(child: ChildProcess, message: object): void {
  if (child.stdin) {
    const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';
    child.stdin.write(JSON.stringify(message) + lineEnding);
  }
}
```

### 读取消息（← 子进程 stdout）

文件：`src/process/agent/acp/AcpConnection.ts`

```typescript
child.stdout?.on('data', (data: Buffer) => {
  const dataStr = data.toString();
  buffer += dataStr;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (line.trim()) {
      const message = JSON.parse(line) as AcpMessage;
      this.handleMessage(message);
    }
  }
});
```

### 协议生命周期

| 步骤 | 方法 | 说明 |
|------|------|------|
| 1 | `initialize` | 握手：`{protocolVersion: 1, clientCapabilities: {fs: {readTextFile, writeTextFile}}}` |
| 2 | `authenticate` | 认证（如需要） |
| 3 | `session/new` | 创建会话（含 cwd, mcpServers, 可选 `_meta.claudeCode.options.resume`） |
| 4 | `session/prompt` | 发送用户消息（主要交互） |
| 5 | `session/set_mode` | 设置模式（如 `bypassPermissions` 即 YOLO 模式） |
| 6 | `session/set_model` | 切换模型 |
| 7 | `session/cancel` | 取消当前生成 |

### 子进程上报的消息类型

| 类型 | 说明 |
|------|------|
| `session/update` | 流式内容块、工具调用、计划 |
| `request/permission` | 工具执行的权限请求 |
| `fs/read_text_file` | 文件读取（由宿主代理） |
| `fs/write_text_file` | 文件写入（由宿主代理） |

---

## 4. 架构分层

```
WorkerTaskManager (单例，注册所有 agent 类型)
  └── AgentFactory (按会话类型创建)
        ├── AcpAgentManager     (acp 类型 — Claude, Qwen, Goose 等)
        │     └── AcpAgent      (协议层)
        │           ├── AcpConnection  (传输层 — spawn + JSON-RPC)
        │           └── AcpAdapter     (消息转换层)
        ├── GeminiAgentManager   (gemini 类型)
        ├── CodexAgentManager    (codex 类型)
        ├── OpenClawAgentManager (openclaw-gateway 类型)
        ├── NanoBotAgentManager  (nanobot 类型)
        └── RemoteAgentManager   (remote 类型 — WebSocket 连接远程 agent)
```

---

## 5. 核心文件索引

| 文件 | 职责 |
|------|------|
| `src/process/task/workerTaskManagerSingleton.ts` | 注册所有 agent 类型到工厂 |
| `src/process/task/WorkerTaskManager.ts` | 任务生命周期管理 |
| `src/process/task/BaseAgentManager.ts` | 基类，含 yolo 模式、确认机制 |
| `src/process/task/AcpAgentManager.ts` | ACP agent 管理器 — 创建 AcpAgent，处理流式、权限、IPC 事件 |
| `src/process/agent/acp/index.ts` | AcpAgent 类 — 协议层 ACP 客户端 |
| `src/process/agent/acp/AcpConnection.ts` | 传输层 — spawn 子进程，处理 stdio，JSON-RPC 消息 |
| `src/process/agent/acp/acpConnectors.ts` | 各后端的 spawn 逻辑（Claude、Codex、CodeBuddy） |
| `src/process/agent/acp/AcpAdapter.ts` | ACP session update → AionUI 消息格式转换 |
| `src/process/agent/acp/AcpDetector.ts` | 启动时检测已安装的 CLI 工具 |
| `src/process/agent/acp/AcpWsTransport.ts` | WebSocket 传输（远程 agent） |
| `src/process/agent/acp/utils.ts` | 进程 kill、文件 I/O、JSON-RPC 写入、Claude 设置读取 |
| `src/process/agent/acp/constants.ts` | 各后端的 YOLO 模式常量 |
| `src/process/agent/remote/RemoteAcpCore.ts` | 远程 ACP agent（WebSocket，无本地 CLI） |
| `src/process/task/RemoteAgentManager.ts` | 远程 agent 管理器 |

---

## 6. 所有支持的 Agent 后端

| 后端 | CLI 命令 | Spawn 方式 |
|------|----------|-----------|
| **claude** | `claude` | `npx @zed-industries/claude-agent-acp@0.21.0` |
| **codex** | `codex` | `npx @zed-industries/codex-acp@0.9.5` |
| **codebuddy** | `codebuddy` | `npx @tencent-ai/codebuddy-code` |
| **qwen** | `qwen` | `npx @qwen-code/qwen-code` |
| **gemini** | `gemini` | 自定义 GeminiConnection（非 ACP） |
| **goose** | `goose` | 直接 spawn，子命令 `acp` |
| **copilot** | `copilot` | 直接 spawn，参数 `--acp --stdio` |
| **kiro** | `kiro-cli` | 直接 spawn，子命令 `acp` |
| **cursor** | `agent` | 直接 spawn，子命令 `acp` |
| **opencode** | `opencode` | 直接 spawn，子命令 `acp` |
| **droid** | `droid` | 直接 spawn，参数 `exec --output-format acp` |
| **custom** | 用户自定义 | 用户配置 |
| **remote** | 无 | WebSocket 连接远程容器 |

---

## 7. Claude 特有行为

### YOLO 模式
文件：`src/process/agent/acp/constants.ts`

```typescript
export const CLAUDE_YOLO_SESSION_MODE = 'bypassPermissions' as const;
```

### 会话恢复
文件：`src/process/agent/acp/AcpConnection.ts`

```typescript
const meta = {
  claudeCode: {
    options: {
      resume: options.resumeSessionId,
    },
  },
};
```

### 模型读取
文件：`src/process/agent/acp/utils.ts`

从 `~/.claude/settings.json` 读取 `env.ANTHROPIC_MODEL` 获取模型配置。

### 认证
文件：`src/process/agent/acp/index.ts`

当认证过期时，spawn `claude /login` 刷新认证 token。

---

## 8. 远程 Agent（WebSocket 模式）

企业部署场景下，agent 可运行在远程容器中，通过 WebSocket 连接：

```typescript
// AcpWsTransport — 远程连接
this.ws = new WebSocket(this.url);
this.ws.send(JSON.stringify({ type: 'auth', token: this.token }));
// auth_ok 后，JSON-RPC 消息双向流动
```

`RemoteAgentManager` 支持 ACP 和 OpenClaw 两种远程协议，根据 `remoteConfig.protocol` 选择。
