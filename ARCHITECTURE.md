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
 │    ├── 部门数字化身 (Dept Agent)         ← 24h 运行
 │    ├── 部门知识库 (Knowledge Base)
 │    └── 员工 (User)
 │         ├── AionUI 工作区                ← 按需启动，空闲回收
 │         ├── 个人数字助理 (Personal Agent) ← 24h 运行
 │         ├── 个人 Agent 集合
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

### 三类运行实例

| 类型 | 生命周期 | 用途 | 运行形式 |
|------|---------|------|---------|
| **AionUI 工作区** | 按需启动，空闲回收 | 员工日常交互 | Docker 容器 |
| **个人数字助理** | 24h 常驻 | 定时任务、记忆、消息通知 | Agent Runtime 容器 |
| **部门数字化身** | 24h 常驻 | 团队协作、公共查询、流程自动化 | Agent Runtime 容器 |

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
                    │  │  反向代理     │  │  Runtime Manager │  │
                    │  │  (HTTP + WS)  │  │  (心跳 & 调度)   │  │
                    │  └──┬───┬───────┘  └────────┬────────┘  │
                    └─────┼───┼──────────────────┼───────────┘
                          │   │                  │
          ┌───────────────┘   │                  │
          ▼                   ▼                  ▼
   ┌────────────┐    ┌───────────┐       ┌──────────────┐
   │  AionUI    │    │  AionUI   │       │ Agent Runtime │
   │  工作区     │    │  工作区    │       │  (容器)       │
   │  (员工A)   │    │  (员工B)  │       │              │
   └──────┬─────┘    └───────────┘       │ ┌──────────┐ │
          │                              │ │Supervisor│ │
          │         直连（SSE/WS）        │ │ :3000    │ │
          └─────────────────────────────►│ ├──────────┤ │
                                         │ │opencode  │ │
                                         │ │serve     │ │
                                         │ │:3001-300N│ │
                                         │ └──────────┘ │
                                         └──────────────┘
```

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 管理后台前端 | **内嵌 SPA** | 一个镜像部署，同源免 CORS，版本一致 |
| Agent Runtime | **独立容器 + opencode serve** | 团队熟悉 opencode，复用其模型调用 / MCP / 对话能力 |
| AionUI ↔ Runtime | **直连，Gateway 不转发** | Gateway 下发连接配置，定期检查心跳；数据面不经过 Gateway |
| 容器内隔离 | **单容器多 opencode serve 进程** | 一个 Runtime 容器内按 Agent 启动多个 opencode serve |
| 存储 | **NFS + PostgreSQL** | 文件数据走 NFS 共享盘，元数据走 PG |
| ORM | **Drizzle ORM**（推荐） | 轻量、类型安全、PG 全特性支持 |

---

## 四、AionUI ↔ Runtime 直连

Gateway 是控制面，不介入数据面转发：

```
Gateway（控制面）                   AionUI 工作区              Runtime
    │                                  │                        │
    │── 下发连接配置 ────────────────► │                        │
    │   { runtimeId, host,             │                        │
    │     agents: [{ id, port }] }     │                        │
    │                                  │── 直连 SSE/WS ────────►│
    │                                  │◄── Agent 响应 ─────────│
    │                                  │                        │
    │── 定期心跳检查 ──────────────────────────────────────────►│
    │◄── 心跳响应 ──────────────────────────────────────────────│
    │                                  │                        │
    │   异常 → 标记状态、触发告警/重建  │                        │
```

Gateway 存储的连接配置：

```typescript
interface RuntimeEndpoint {
  runtimeId: string;
  host: string;
  supervisorPort: number;          // Supervisor 健康检查端口
  agents: {
    agentId: string;
    port: number;                  // 该 Agent 对应的 opencode serve 端口
    name: string;
  }[];
}
```

---

## 五、Agent Runtime 容器设计

### 容器内部结构

```
Agent Runtime 容器
┌──────────────────────────────────────────────────┐
│  Runtime Supervisor（进程管理器，:3000）           │
│                                                  │
│  职责：                                          │
│  · 启动/停止 opencode serve 进程                 │
│  · 监控进程存活，崩溃自动重启                     │
│  · 向 Gateway 上报心跳（聚合所有 Agent 状态）     │
│  · 定时任务本地 cron 执行                         │
│  · Token 用量聚合上报                             │
│  · 对接通知渠道（企微/钉钉/邮件）                 │
│                                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────┐│
│  │ opencode     │ │ opencode     │ │ opencode   ││
│  │ serve        │ │ serve        │ │ serve      ││
│  │ --dir agent-a│ │ --dir agent-b│ │ --dir ...  ││
│  │ :3001        │ │ :3002        │ │ :300N      ││
│  └──────────────┘ └──────────────┘ └────────────┘│
│                                                  │
│  /data/agents/                                   │
│  ├── agent-a/                                    │
│  │   ├── opencode.yaml        # opencode 配置    │
│  │   ├── memory/              # 记忆存储         │
│  │   └── workspace/           # 工作目录         │
│  ├── agent-b/                                    │
│  └── agent-c/                                    │
└──────────────────────────────────────────────────┘
```

### 容器归属策略

按**用户**或**部门**划分：

```
用户 A 的 Runtime 容器：
├── :3001  个人助理 Agent
├── :3002  自建"日报生成"Agent
└── :3003  自建"代码审查"Agent

部门 X 的 Runtime 容器：
├── :3001  部门数字化身
├── :3002  部门公共查询 Agent
└── :3003  部门周报 Agent
```

### Supervisor API

```
Supervisor 提供 HTTP API（:3000）：
├── GET  /health                — 健康检查 + 各 Agent 进程状态
├── POST /agents/:id/start      — 启动指定 Agent 的 opencode serve
├── POST /agents/:id/stop       — 停止指定 Agent
├── POST /agents/:id/restart    — 重启指定 Agent
├── GET  /agents/:id/status     — 单个 Agent 状态
└── GET  /metrics               — 用量统计
```

### opencode serve 补齐能力

opencode 已具备模型调用、MCP 工具、对话交互、文件读写等核心能力。
Supervisor 层补齐以下缺口：

| 能力 | opencode 现状 | Supervisor 补齐方式 |
|------|-------------|-------------------|
| 定时触发 | 请求驱动，无 cron | Supervisor 内置 cron，定时调 opencode API |
| 长期记忆 | 会话内上下文，无跨会话持久化 | Agent 目录下文件存储，通过 MCP 工具读写 |
| 主动通知 | 只能被动响应 | Supervisor 对接消息通道 |
| 用量上报 | 无 | Supervisor 拦截/聚合后上报 Gateway |
| 多 Agent 协作 | 单进程独立 | Supervisor 层协调 |

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
├── 实例 & Runtime 状态
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

**Agent Runtime 容器（员工的 Agent 们）：**

```
-v agents/agent-a/              → /data/agents/agent-a
-v agents/agent-b/              → /data/agents/agent-b
-v configs/opencode-base.yaml   → /config/opencode-base.yaml (只读)
-v skills/                      → /skills (只读)
```

**部门 Runtime 容器：**

```
-v agents/dept-agent-x/         → /data/agents/dept-agent-x
-v departments/{deptId}/        → /shared
-v skills/                      → /skills (只读)
```

### NFS 注意事项

| 问题 | 应对策略 |
|------|---------|
| 并发写入冲突 | 设计上避免同一文件并发写：每个 Agent 独立工作目录 |
| 大量小文件读取延迟 | Agent 目录中设 `_index.yaml` 索引文件，避免遍历 |
| NFS 挂载失败 | Supervisor 启动时检查挂载点可用性，不可用则上报 Gateway 等待重试 |
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
│   ├── GET    /workspace            # 工作区状态 & Runtime 连接信息
│   ├── GET    /agents               # 我的 Agent 列表
│   ├── CRUD   /agents/:id           # Agent 管理
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
│   ├── /resources                   # 资源监控（实例 & Runtime 状态）
│   ├── /usage                       # Token 用量统计（按人/部门/Agent）
│   ├── /schedules                   # 定时任务全局视图
│   ├── /mcp-endpoints               # MCP 接口管理
│   ├── /knowledge-bases             # 知识库管理
│   ├── /model-configs               # 模型配置管理
│   └── /notification-channels       # 通知渠道管理
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
  ├── runtimes (Agent Runtime 容器)                       │
  ├── instances (AionUI 工作区容器)                        │
  ├── model_configs                                       │
  └── token_usage                                         │
```

### 完整表结构

```sql
-- ═══════════════════════════════════════════
-- 租户
-- ═══════════════════════════════════════════

CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    settings        JSONB NOT NULL DEFAULT '{}',
    nfs_root        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════
-- 部门（支持多级树形结构）
-- ═══════════════════════════════════════════

CREATE TABLE departments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    parent_id       UUID REFERENCES departments(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    settings        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, name)
);

-- ═══════════════════════════════════════════
-- 用户
-- ═══════════════════════════════════════════

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    department_id   UUID REFERENCES departments(id) ON DELETE SET NULL,
    oauth_provider  TEXT NOT NULL,
    oauth_id        TEXT NOT NULL,
    username        TEXT NOT NULL,
    display_name    TEXT NOT NULL DEFAULT '',
    avatar_url      TEXT NOT NULL DEFAULT '',
    email           TEXT,
    role            TEXT NOT NULL DEFAULT 'member',
    status          TEXT NOT NULL DEFAULT 'active',
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, oauth_provider, oauth_id)
);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_department ON users(department_id);

-- ═══════════════════════════════════════════
-- 模型配置
-- ═══════════════════════════════════════════

CREATE TABLE model_configs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    provider            TEXT NOT NULL,
    model_id            TEXT NOT NULL,
    api_key             TEXT NOT NULL,
    base_url            TEXT,
    config              JSONB NOT NULL DEFAULT '{}',
    is_default          BOOLEAN NOT NULL DEFAULT false,
    token_limit_daily   INTEGER,
    token_limit_monthly INTEGER,
    status              TEXT NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, name)
);

-- ═══════════════════════════════════════════
-- Agent
-- ═══════════════════════════════════════════

CREATE TYPE agent_scope AS ENUM ('personal', 'department', 'tenant');
CREATE TYPE agent_status AS ENUM ('draft', 'published', 'archived');

CREATE TABLE agents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    owner_type      TEXT NOT NULL,
    owner_id        UUID NOT NULL,
    scope           agent_scope NOT NULL DEFAULT 'personal',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    system_prompt   TEXT NOT NULL DEFAULT '',
    model_config_id UUID REFERENCES model_configs(id),
    opencode_config JSONB NOT NULL DEFAULT '{}',
    settings        JSONB NOT NULL DEFAULT '{}',
    status          agent_status NOT NULL DEFAULT 'draft',
    nfs_path        TEXT,
    runtime_id      UUID,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agents_tenant ON agents(tenant_id);
CREATE INDEX idx_agents_owner ON agents(owner_type, owner_id);
CREATE INDEX idx_agents_runtime ON agents(runtime_id);

-- ═══════════════════════════════════════════
-- Skill
-- ═══════════════════════════════════════════

CREATE TYPE skill_scope AS ENUM ('personal', 'department', 'tenant');

CREATE TABLE skills (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    owner_type      TEXT NOT NULL,
    owner_id        UUID NOT NULL,
    scope           skill_scope NOT NULL DEFAULT 'personal',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    trigger_type    TEXT NOT NULL DEFAULT 'on_demand',
    input_schema    JSONB NOT NULL DEFAULT '{}',
    prompt_template TEXT NOT NULL DEFAULT '',
    mcp_tools       JSONB NOT NULL DEFAULT '[]',
    output_format   TEXT NOT NULL DEFAULT 'text',
    nfs_path        TEXT,
    status          agent_status NOT NULL DEFAULT 'draft',
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_skills_tenant ON skills(tenant_id);

-- Agent ↔ Skill 关联
CREATE TABLE agent_skills (
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    skill_id    UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    config      JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (agent_id, skill_id)
);

-- ═══════════════════════════════════════════
-- MCP 接口
-- ═══════════════════════════════════════════

CREATE TABLE mcp_endpoints (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    type            TEXT NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}',
    required_tools  JSONB NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'active',
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, name)
);

CREATE TABLE agent_mcp_endpoints (
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    mcp_endpoint_id UUID NOT NULL REFERENCES mcp_endpoints(id) ON DELETE CASCADE,
    config          JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (agent_id, mcp_endpoint_id)
);

-- ═══════════════════════════════════════════
-- 知识库
-- ═══════════════════════════════════════════

CREATE TABLE knowledge_bases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    owner_type      TEXT NOT NULL,
    owner_id        UUID NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    nfs_path        TEXT NOT NULL,
    indexing_config JSONB NOT NULL DEFAULT '{}',
    doc_count       INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active',
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_knowledge_bases (
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    knowledge_base_id   UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    access_mode         TEXT NOT NULL DEFAULT 'readonly',
    PRIMARY KEY (agent_id, knowledge_base_id)
);

-- ═══════════════════════════════════════════
-- 定时任务
-- ═══════════════════════════════════════════

CREATE TYPE schedule_status AS ENUM ('active', 'paused', 'error');

CREATE TABLE schedules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    cron            TEXT NOT NULL,
    input           JSONB NOT NULL DEFAULT '{}',
    timezone        TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    status          schedule_status NOT NULL DEFAULT 'active',
    last_run_at     TIMESTAMPTZ,
    next_run_at     TIMESTAMPTZ,
    failure_count   INTEGER NOT NULL DEFAULT 0,
    config          JSONB NOT NULL DEFAULT '{}',
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_schedules_next_run ON schedules(next_run_at) WHERE status = 'active';

-- 定时任务执行记录
CREATE TABLE schedule_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id     UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    runtime_id      UUID,
    status          TEXT NOT NULL,
    input           JSONB NOT NULL DEFAULT '{}',
    output          TEXT,
    error           TEXT,
    token_usage     JSONB DEFAULT '{}',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    duration_ms     INTEGER
);
CREATE INDEX idx_schedule_logs_schedule ON schedule_logs(schedule_id, started_at DESC);

-- ═══════════════════════════════════════════
-- Runtime 实例（Agent 运行时容器）
-- ═══════════════════════════════════════════

CREATE TYPE runtime_status AS ENUM ('starting', 'running', 'unhealthy', 'stopping', 'stopped');

CREATE TABLE runtimes (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    owner_type        TEXT NOT NULL,
    owner_id          UUID NOT NULL,
    container_id      TEXT,
    container_name    TEXT NOT NULL,
    host              TEXT NOT NULL DEFAULT '127.0.0.1',
    ports             JSONB NOT NULL DEFAULT '[]',
    supervisor_port   INTEGER NOT NULL,
    status            runtime_status NOT NULL DEFAULT 'starting',
    health_checked_at TIMESTAMPTZ,
    last_heartbeat    TIMESTAMPTZ,
    memory_limit      TEXT NOT NULL DEFAULT '1g',
    cpu_limit         TEXT NOT NULL DEFAULT '1',
    started_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_runtimes_owner ON runtimes(owner_type, owner_id);
CREATE INDEX idx_runtimes_status ON runtimes(status);

-- ═══════════════════════════════════════════
-- AionUI 工作区实例
-- ═══════════════════════════════════════════

CREATE TYPE instance_status AS ENUM ('starting', 'running', 'unhealthy', 'stopping', 'stopped');

CREATE TABLE instances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    container_id    TEXT,
    container_name  TEXT NOT NULL,
    host            TEXT NOT NULL DEFAULT '127.0.0.1',
    port            INTEGER NOT NULL,
    status          instance_status NOT NULL DEFAULT 'starting',
    last_active_at  TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    nfs_mounts      JSONB NOT NULL DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_instances_status ON instances(status);

-- ═══════════════════════════════════════════
-- Token 用量统计
-- ═══════════════════════════════════════════

CREATE TABLE token_usage (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
    agent_id          UUID REFERENCES agents(id) ON DELETE SET NULL,
    model_config_id   UUID REFERENCES model_configs(id),
    source            TEXT NOT NULL,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    cost              NUMERIC(12, 6) NOT NULL DEFAULT 0,
    metadata          JSONB NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_token_usage_tenant_date ON token_usage(tenant_id, created_at);
CREATE INDEX idx_token_usage_user ON token_usage(user_id, created_at);
CREATE INDEX idx_token_usage_agent ON token_usage(agent_id, created_at);

-- ═══════════════════════════════════════════
-- 通知渠道
-- ═══════════════════════════════════════════

CREATE TABLE notification_channels (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    config      JSONB NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, name)
);

CREATE TABLE agent_notification_channels (
    agent_id                UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    notification_channel_id UUID NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    events                  JSONB NOT NULL DEFAULT '[]',
    config                  JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (agent_id, notification_channel_id)
);
```

---

## 十、项目结构（目标）

```
aionui-gateway/
├── src/                              # 后端 (TypeScript, Express)
│   ├── index.ts                      # 入口
│   ├── config/                       # 配置管理
│   ├── auth/                         # SSO / OAuth2 / SAML / OIDC
│   ├── database/                     # PostgreSQL (Drizzle ORM)
│   │   ├── schema/                   # 表定义
│   │   └── migrations/               # 数据库迁移
│   ├── instance/                     # AionUI 工作区容器管理
│   ├── runtime/                      # Agent Runtime 容器管理
│   ├── scheduler/                    # 定时任务调度
│   ├── middleware/                   # 认证守卫、RBAC 权限
│   ├── proxy/                        # 反向代理 (HTTP + WS)
│   ├── routes/                       # 路由
│   │   ├── gateway.ts                # 登录页 / OAuth 回调
│   │   ├── user.ts                   # /api/user/* 员工端 API
│   │   └── admin.ts                  # /api/admin/* 管理端 API
│   └── types/                        # TypeScript 类型定义
│
├── admin/                            # 管理后台前端 (内嵌 SPA)
│   ├── src/
│   ├── dist/                         # 构建产物
│   ├── package.json
│   └── vite.config.ts
│
├── runtime/                          # Agent Runtime Supervisor（独立镜像源码）
│   ├── src/
│   │   ├── supervisor.ts             # 进程管理
│   │   ├── scheduler.ts              # 本地 cron 执行
│   │   ├── heartbeat.ts              # 心跳上报
│   │   └── metrics.ts                # 用量统计
│   ├── Dockerfile
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

### Phase 2 — 智能体运行时

- Agent Runtime 容器管理
- Runtime Supervisor 开发
- AionUI ↔ Runtime 直连
- 定时任务调度器
- Token 用量统计

### Phase 3 — 管理平台

- 管理后台前端（内嵌 SPA）
- 资源监控 Dashboard
- MCP 接口市场
- 知识库管理
- 通知渠道对接
- Agent 发布 & 分发流程

---

## 十二、待讨论事项

以下问题在后续讨论中逐步明确：

1. **Runtime Supervisor 技术栈** — Node.js 还是更轻量方案
2. **消息通知优先级** — 企业微信 / 钉钉 / 邮件，首先支持哪个
3. **Agent 记忆的索引机制** — `_index.yaml` 文件结构的具体设计
4. **多 Gateway 实例高可用** — 负载均衡、Session 共享方案
5. **API 鉴权方案** — AionUI 直连 Runtime 时的身份校验
6. **Agent 版本管理** — 是否需要版本快照和回滚
