# OpenCode 配置挂载参考

OpenCode Runtime 容器的配置通过 Docker volume 挂载注入，共 **3 个挂载点**、**1 个核心生成文件**。

## 挂载点总览

```
宿主机                                            容器内
──────────────────────────────────────────────   ───────────────────────────────────
sessions/${sid}/config/opencode/              →  /home/appuser/.config/opencode/      ① 配置目录
sessions/${sid}/data/opencode/                →  /home/appuser/.local/share/opencode/  ② 数据目录
agents/${agentId}/                            →  /workspace                            ③ 工作区
```

环境变量：`OPENCODE_CONFIG_DIR=/home/appuser/.config/opencode`

---

## ① 配置目录 `~/.config/opencode/`

用户级配置，所有 OpenCode 配置项的主入口。

| 文件 / 目录 | 功能 | 注入方式 |
|-------------|------|---------|
| `opencode.json` | 核心配置文件（模型、Provider、MCP、权限等） | Gateway `injectOpenCode()` 动态生成 |
| `agents/*.md` | 自定义 Agent 定义，每个 `.md` 文件 = 一个 Agent | `copyGlobalConfig` 从全局模板拷贝 |
| `commands/*.md` | 自定义斜杠命令，每个 `.md` 文件 = 一个 `/command` | 同上 |
| `skills/` | Agent 技能定义 | 同上 |
| `modes/` | 模式定义 | 同上 |
| `plugins/` | 插件 | 同上 |
| `tools/` | 自定义工具 | 同上 |
| `themes/` | 主题（ACP 模式下一般不需要） | 同上 |

> **注意**：OpenCode 同时支持单数和复数目录名（`agent/` 和 `agents/`），建议统一使用复数。

---

## ② 数据目录 `~/.local/share/opencode/`

运行时数据，由 OpenCode 进程自动写入。

| 用途 | 说明 |
|------|------|
| 会话历史 | 对话记录、交互日志 |
| 运行时状态 | 快照、索引等临时数据 |

容器内写入的数据通过挂载回写到宿主机，可用于审计和持久化。

---

## ③ 工作区 `/workspace`

Agent 的项目工作目录，对应宿主机上的 agent 目录。

| 文件 / 目录 | 功能 |
|-------------|------|
| `AGENTS.md` | 项目级 Agent 指令（相当于 system prompt） |
| `.opencode/` | 项目级配置覆盖（结构同 ①，优先级高于用户级） |
| `.opencode/agents/*.md` | 项目级自定义 Agent |
| `.opencode/commands/*.md` | 项目级自定义命令 |
| 源码文件 | Agent 实际读写代码的位置 |

---

## opencode.json 字段参考

`opencode.json` 是核心配置文件，由 Gateway 的 `injectOpenCode()` 函数根据请求参数动态生成。

### 字段清单

| 字段 | 类型 | 用途 | 容器默认值 |
|------|------|------|-----------|
| `model` | `string` | 主模型（如 `"anthropic/claude-sonnet-4-5"`) | — |
| `small_model` | `string` | 轻量模型，用于标题生成等辅助任务 | — |
| `default_agent` | `string` | 默认使用的 Agent 名称 | — |
| `provider` | `object` | Provider 配置（支持多个，每个含 apiKey/timeout/cache） | — |
| `mcp` | `object` | MCP 服务器配置（local/remote） | — |
| `permission` | `object` | 工具权限控制（edit/bash/webfetch，支持 glob 模式） | — |
| `agent` | `object` | 内联 Agent 定义（等同于 agents/ 目录下的 .md 文件） | — |
| `instructions` | `string[]` | 引用外部规则文件的路径列表 | — |
| `plugin` | `object` | npm 插件声明 | — |
| `disabled_providers` | `string[]` | 禁用的 Provider 列表 | — |
| `compaction` | `object` | 上下文压缩策略（enabled/threshold 等） | — |
| `snapshot` | `boolean` | 文件快照开关 | `false` |
| `formatter` | `object` | 代码格式化器配置 | — |
| `autoupdate` | `boolean \| "notify"` | 自动更新开关 | `false` |
| `share` | `"manual" \| "auto" \| "disabled"` | 会话分享功能 | `"disabled"` |
| `tools` | `object` | 工具开关（按名称 enable/disable） | — |
| `watcher` | `object` | 文件监控 ignore 模式 | — |

> 标注"容器默认值"的字段由 `OPENCODE_CONTAINER_DEFAULTS` 提供，确保容器环境下不会自动更新、不创建快照、不开启分享。

### 示例

```jsonc
{
  // 容器默认值（自动注入）
  "autoupdate": false,
  "share": "disabled",
  "snapshot": false,

  // 模型配置
  "model": "anthropic/claude-sonnet-4-5",
  "small_model": "anthropic/claude-haiku-3",
  "default_agent": "build",

  // Provider（支持多个）
  "provider": {
    "anthropic": {
      "options": { "apiKey": "sk-ant-xxx" }
    },
    "openai": {
      "options": { "apiKey": "sk-xxx" }
    }
  },

  // MCP 服务器
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

  // 工具权限
  "permission": {
    "edit": "ask",
    "bash": "ask",
    "bash(npm *)": "allow",
    "bash(git *)": "allow"
  },

  // 内联 Agent 定义
  "agent": {
    "reviewer": {
      "description": "Code review agent",
      "instructions": "Review code for bugs and style issues",
      "model": "anthropic/claude-sonnet-4-5",
      "tools": ["read", "glob", "grep"],
      "permission": { "edit": "deny" }
    }
  },

  // 外部规则文件
  "instructions": [
    "/workspace/.opencode/rules/*.md"
  ]
}
```

---

## 配置注入流程

```
                        ┌─────────────────────────┐
                        │  global-config/opencode/ │  用户全局模板
                        │  (agents/ commands/ ...) │
                        └───────────┬─────────────┘
                                    │ copyGlobalConfig()
                                    ▼
               ┌──────────────────────────────────────────┐
               │  sessions/${sid}/config/opencode/         │
               │  ├── agents/  commands/  skills/  ...    │  子目录（直接拷贝）
               │  └── opencode.json                       │  核心配置文件
               └──────────────────┬───────────────────────┘
                                  │ injectOpenCode()
                                  │ 三层深度合并:
                                  │   CONTAINER_DEFAULTS
                                  │     ← 磁盘已有模板
                                  │       ← 动态注入配置
                                  ▼
               ┌──────────────────────────────────────────┐
               │  opencode.json（最终版）                   │
               └──────────────────┬───────────────────────┘
                                  │ Docker -v 挂载
                                  ▼
               ┌──────────────────────────────────────────┐
               │  容器: /home/appuser/.config/opencode/    │
               │  OpenCode CLI 启动时读取                   │
               └──────────────────────────────────────────┘
```

### 合并优先级（低 → 高）

1. **CONTAINER_DEFAULTS** — 容器安全默认值（autoupdate=false, share=disabled, snapshot=false）
2. **磁盘模板** — `copyGlobalConfig` 从全局模板拷贝过来的 opencode.json
3. **动态注入** — `injectOpenCode()` 根据 API 请求参数生成的配置

使用 `deepMerge` 递归合并，嵌套对象（provider、mcp、permission 等）不会被覆盖，而是逐层合并。

---

## 配置优先级链（OpenCode 内部）

OpenCode 自身也有配置合并链，从低到高：

```
Remote config (.well-known/opencode)
  → Global config (~/.config/opencode/opencode.json)   ← 我们挂载到这里
    → Custom config (OPENCODE_CONFIG env)
      → Project config (/workspace/opencode.json)
        → .opencode/ 目录
          → OPENCODE_CONFIG_CONTENT env (inline JSON)
```

我们的注入点在 **Global config** 层。如果 `/workspace` 下有项目级的 `opencode.json` 或 `.opencode/` 目录，OpenCode 会进一步合并，项目级配置优先。

---

## 相关源码

| 文件 | 职责 |
|------|------|
| `src/services/runtime-config.ts` | `injectOpenCode()` — 动态生成 opencode.json |
| `src/services/runtime-mounts.ts` | OpenCode 挂载点定义 |
| `src/services/runtime-fs.ts` | `copyGlobalConfig()` — 全局模板拷贝 |
| `src/routes/agent-connect.ts` | 容器创建编排 |
| `agent-runtime/images/opencode/Dockerfile` | 镜像定义 |
