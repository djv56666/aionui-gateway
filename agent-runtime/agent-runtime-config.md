# Agent Runtime 配置注入方案

> 配置规则：Gateway 在创建 Runtime 容器时，根据会话请求参数动态生成配置文件并挂载到容器内对应路径。容器是无状态执行单元，所有状态由挂载的宿主机目录承载。会话结束后容器销毁，宿主机文件保留。

## 核心原则

1. **按需启动** — 客户端发起会话时，Gateway 根据参数动态创建容器
2. **配置与运行时分离** — 配置文件由 Gateway 生成，通过 Docker volume 挂载注入，不打包在镜像中
3. **分目录挂载** — 不同 runtime 挂载不同路径，互不干扰
4. **容器无状态** — 会话结束容器销毁，宿主机文件持久保留
5. **每会话一份拷贝** — 全局配置在启动时拷贝到会话实例目录，多实例互不影响

## 数据分层

| 层级 | 说明 | 存储位置 | 生命周期 |
|------|------|----------|----------|
| ① 用户全局配置 | 用户级偏好、模型、权限、MCP、API Key | `global-config/` | 持久，跨会话复用 |
| ② Agent 项目 | 包含 CLAUDE.md 的项目目录，即 workspace | `agents/${agentId}/` | 持久，随项目存在 |
| ③ 会话运行时数据 | 会话历史、状态 | `sessions/${sessionId}/runtime-data/` | 持久，容器销毁后保留 |

## 宿主机目录结构

```
${dataRoot}/users/${userId}/
│
├── global-config/                          # ① 用户全局配置（模板，启动时拷贝）
│   ├── opencode/
│   │   ├── opencode.json                   # model、provider、apiKey、mcp、permission、tools
│   │   ├── agents/                         # 自定义 Agent 定义（.md 文件）
│   │   ├── commands/                       # 自定义命令（.md 文件）
│   │   └── plugins/                        # 扩展插件
│   │
│   ├── claude/
│   │   ├── settings.json                   # 权限、hooks、env、模型默认
│   │   ├── CLAUDE.md                       # 全局指令
│   │   ├── skills/                         # 全局 Skills
│   │   │   └── <name>/SKILL.md
│   │   ├── agents/                         # 子代理定义
│   │   │   └── <name>.md
│   │   ├── rules/                          # 主题指令
│   │   │   └── <topic>.md
│   │   └── commands/                       # 全局命令
│   │       └── <name>.md
│   │
│   ├── claude.json                         # OAuth 状态、个人 MCP 服务器（mcpServers 字段）
│   │
│   └── goose/
│       └── config.yaml                     # provider、extensions（含 MCP）
│
├── agents/${agentId}/                      # ② Agent 项目 = workspace
│   ├── CLAUDE.md                           # Agent 定义（OpenCode/Claude 启动时读取）
│   ├── .mcp.json                           # 项目级 MCP 服务器（Claude Code 用）
│   ├── opencode.json                       # 项目级 OpenCode 配置（可选覆盖）
│   ├── .claude/                            # 项目级 Claude 配置（可选）
│   │   └── settings.json
│   ├── .opencode/                          # 项目级 OpenCode 扩展（可选）
│   │   ├── agents/
│   │   └── commands/
│   └── src/                                # 工作成果直接写入这里
│
└── sessions/${sessionId}/                  # ③ 会话实例（每次启动时创建）
    ├── config/                             # 从 global-config 拷贝的配置副本
    │   ├── opencode/
    │   ├── claude/
    │   ├── claude.json
    │   └── goose/
    ├── data/                               # 从 global-data 拷贝（或新建）
    │   ├── opencode/                       # 会话历史
    │   └── goose/                          # 会话历史
    └── runtime-data/                       # 运行时产生的数据
```

## Runtime 挂载映射表

Gateway 内部维护一张映射表，根据 runtime 类型动态组装 `docker run` 的挂载参数。

### OpenCode

| 挂载源（宿主机） | 容器内路径 | 内容 |
|---|---|---|
| `sessions/${sid}/config/opencode/` | `/home/appuser/.config/opencode/` | 主配置、agents、commands、plugins |
| `sessions/${sid}/data/opencode/` | `/home/appuser/.local/share/opencode/` | 会话历史、数据库 |
| `agents/${agentId}/` | `/workspace` | Agent 项目（含 CLAUDE.md） |

额外环境变量（可选覆盖）：

```bash
OPENCODE_CONFIG_DIR=/home/appuser/.config/opencode   # 自定义配置目录
OPENCODE_CONFIG=/home/appuser/.config/opencode/opencode.json  # 自定义配置文件
OPENCODE_CONFIG_CONTENT='{ ... }'                     # 内联 JSON 配置（最高优先级）
```

配置文件 `opencode.json` 示例：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "sk-xxx..."
      }
    }
  },
  "permission": {
    "edit": "ask",
    "bash": "ask"
  },
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    },
    "github": {
      "type": "remote",
      "url": "https://api.github.com/mcp",
      "enabled": true
    }
  },
  "enabled_providers": ["anthropic", "openai"],
  "instructions": ["./CLAUDE.md"]
}
```

### Claude Code

| 挂载源（宿主机） | 容器内路径 | 内容 |
|---|---|---|
| `sessions/${sid}/config/claude/` | `/home/appuser/.claude/` | settings、CLAUDE.md、skills、agents、rules |
| `sessions/${sid}/config/claude.json` | `/home/appuser/.claude.json` | OAuth、个人 MCP（mcpServers） |
| `agents/${agentId}/` | `/workspace` | Agent 项目（含 CLAUDE.md） |

Claude Code 不支持环境变量重定向配置目录，必须挂载到默认路径。

配置文件示例：

**settings.json**:
```jsonc
{
  "permissions": {
    "allow": ["Bash(npm test)", "Read"],
    "deny": ["Bash(rm -rf /)"]
  },
  "hooks": {},
  "env": {
    "ANTHROPIC_API_KEY": "sk-xxx..."
  }
}
```

**claude.json**（个人 MCP）:
```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-github"]
    }
  }
}
```

**项目级 .mcp.json**（位于 workspace 根目录）:
```jsonc
{
  "mcpServers": {
    "project-db": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite"]
    }
  }
}
```

### Goose

| 挂载源（宿主机） | 容器内路径 | 内容 |
|---|---|---|
| `sessions/${sid}/config/goose/` | `/home/appuser/.config/goose/` | 主配置（含 provider、extensions/MCP） |
| `sessions/${sid}/data/goose/` | `/home/appuser/.local/share/goose/sessions/` | 会话历史 |
| `agents/${agentId}/` | `/workspace` | Agent 项目 |

### 通用挂载（所有 runtime）

| 参数 | 说明 |
|---|---|
| `-v ${agentDir}:/workspace` | Agent 项目即 workspace |
| `-e AGENT_ID=${agentId}` | Agent 标识 |
| `-e WORK_DIR=/workspace` | 工作目录 |

## Gateway 映射配置（代码级）

```typescript
interface MountProfile {
  mounts: Array<{
    hostSubDir: string;      // 相对于 sessions/${sid}/ 的子路径
    containerPath: string;   // 容器内绝对路径
    file?: boolean;          // 是否为单文件（而非目录）
  }>;
  env: Record<string, string>;  // 额外环境变量
}

const RUNTIME_MOUNT_PROFILES: Record<string, MountProfile> = {
  opencode: {
    mounts: [
      { hostSubDir: 'config/opencode', containerPath: '/home/appuser/.config/opencode' },
      { hostSubDir: 'data/opencode',   containerPath: '/home/appuser/.local/share/opencode' },
    ],
    env: {
      OPENCODE_CONFIG_DIR: '/home/appuser/.config/opencode',
    },
  },
  claude: {
    mounts: [
      { hostSubDir: 'config/claude',      containerPath: '/home/appuser/.claude' },
      { hostSubDir: 'config/claude.json', containerPath: '/home/appuser/.claude.json', file: true },
    ],
    env: {},
  },
  goose: {
    mounts: [
      { hostSubDir: 'config/goose', containerPath: '/home/appuser/.config/goose' },
      { hostSubDir: 'data/goose',   containerPath: '/home/appuser/.local/share/goose/sessions' },
    ],
    env: {},
  },
};
```

## 容器创建流程

```
1. 客户端发起会话请求 { userId, agentId, runtimeType }
     ↓
2. 从 global-config/${runtimeType} 拷贝到 sessions/${sessionId}/config/
   从 global-data/${runtimeType} 拷贝到 sessions/${sessionId}/data/（或新建）
     ↓
3. 查 RUNTIME_MOUNT_PROFILES[runtimeType]，组装 -v 和 -e 参数
     ↓
4. 执行 docker run
   -v agents/${agentId}:/workspace
   -v sessions/${sid}/config/...:/home/appuser/.xxx      (按映射表)
   -v sessions/${sid}/data/...:/home/appuser/.local/...  (按映射表)
   -e AGENT_ID / WORK_DIR / 其他环境变量
     ↓
5. 容器运行，Runtime 读取挂载的配置文件和 CLAUDE.md
     ↓
6. 会话结束 → 容器销毁 → 宿主机 sessions/ 下的文件保留
```

## MCP 配置汇总

| Runtime | MCP 配置位置 | 作用域 |
|---------|-------------|--------|
| OpenCode | `opencode.json` 的 `mcp` 字段 | 全局（随配置文件注入） |
| Claude Code | `.mcp.json`（workspace 根目录） | 项目级（随 agent 项目走） |
| Claude Code | `claude.json` 的 `mcpServers` 字段 | 个人级（随全局配置注入） |
| Goose | `config.yaml` 的 `extensions` 字段 | 全局（随配置文件注入） |

MCP 配置由 Gateway 在生成配置文件时写入，不需要额外的挂载机制。
