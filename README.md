# AionUi Gateway

OAuth2 认证网关，为 AionUi 提供多用户部署能力。每位用户登录后自动获得一个独立的 AionUi Docker 容器实例，所有请求经 Gateway 反向代理透明路由。

## 架构概览

```
                    ┌──────────────────────────────┐
                    │        AionUi Gateway        │
                    │       (Express + Node)        │
  Browser ────────► │                              │
                    │  ┌────────┐  ┌────────────┐  │
                    │  │ OAuth2 │  │  Session    │  │
                    │  │ Login  │  │  (Cookie)   │  │
                    │  └────────┘  └────────────┘  │
                    │         │                    │
                    │         ▼                    │
                    │  ┌───────────────────────┐   │
                    │  │   Reverse Proxy        │   │
                    │  │   (HTTP + WebSocket)   │   │
                    │  └──────┬───┬───┬────────┘   │
                    └─────────┼───┼───┼────────────┘
                              │   │   │
               ┌──────────────┘   │   └──────────────┐
               ▼                  ▼                  ▼
        ┌────────────┐   ┌────────────┐   ┌────────────┐
        │  AionUi    │   │  AionUi    │   │  AionUi    │
        │  :4001     │   │  :4002     │   │  :4003     │
        │  (User A)  │   │  (User B)  │   │  (User C)  │
        └────────────┘   └────────────┘   └────────────┘
          Docker容器        Docker容器        Docker容器
```

## 核心特性

- **多 OAuth2 Provider** — 支持 GitHub、Google、Zhimi CAS 三种登录方式，可按需启用
- **自动容器管理** — 用户登录后自动拉起 Docker 容器，空闲超时自动回收
- **反向代理** — HTTP 和 WebSocket 请求透明代理到用户容器，支持 Cookie 透传
- **数据持久化** — 每用户独立数据目录，容器重启不丢数据
- **资源隔离** — 每容器限制 512MB 内存、1 CPU、256 PID
- **安全防护** — Helmet 安全头、CSRF State 校验、HttpOnly Cookie Session
- **优雅关停** — SIGINT/SIGTERM 信号触发所有容器清理

## 技术栈

| 组件 | 技术选型 |
|------|---------|
| 运行时 | Node.js ≥ 22 |
| 语言 | TypeScript (ES2022, ESM) |
| Web 框架 | Express 5 |
| 反向代理 | http-proxy-middleware |
| 数据库 | SQLite (better-sqlite3, WAL 模式) |
| 会话 | cookie-session |
| 容器化 | Docker |
| 安全 | Helmet |

## 项目结构

```
src/
├── index.ts              # 入口：Express 应用初始化、生命周期管理
├── config/index.ts       # 环境变量配置集中管理
├── auth/oauth.ts         # OAuth2 Authorization Code 流程实现
├── database/index.ts     # SQLite 数据库 Schema 与 CRUD 操作
├── instance/manager.ts   # Docker 容器生命周期管理（创建/回收/空闲检测）
├── middleware/auth.ts    # 认证守卫中间件
├── proxy/index.ts        # 反向代理（HTTP + WebSocket）
├── routes/gateway.ts     # 登录页、OAuth 回调、登出等网关路由
└── types/index.ts        # TypeScript 类型定义
```

## 快速开始

### 前置条件

- Node.js ≥ 22
- Docker（已安装并正在运行）
- 已构建 AionUi Docker 镜像（默认 `aionui:latest`）

### 安装

```bash
npm install
```

### 配置

复制环境变量模板并按需修改：

```bash
cp .env.example .env
```

关键配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GATEWAY_PORT` | Gateway 监听端口 | `3000` |
| `GATEWAY_SESSION_SECRET` | Cookie Session 签名密钥 | - |
| `GATEWAY_SECRET` | Gateway 与 AionUi 实例间的共享密钥 | - |
| `DOCKER_IMAGE` | AionUi Docker 镜像名 | `aionui:latest` |
| `INSTANCE_PORT_START` | 用户实例端口范围起始 | `4001` |
| `INSTANCE_PORT_END` | 用户实例端口范围结束 | `4100` |
| `INSTANCE_DATA_ROOT` | 用户数据存储根目录 | `./data/users` |
| `INSTANCE_IDLE_TIMEOUT` | 实例空闲回收超时（秒） | `1800` |
| `OAUTH_GITHUB_CLIENT_ID` | GitHub OAuth App Client ID | - |
| `OAUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth App Client Secret | - |
| `OAUTH_GOOGLE_CLIENT_ID` | Google OAuth Client ID（可选） | - |
| `OAUTH_GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret（可选） | - |
| `OAUTH_ZHIMI_CLIENT_ID` | Zhimi CAS Client ID | - |
| `OAUTH_ZHIMI_CLIENT_SECRET` | Zhimi CAS Client Secret | - |
| `OAUTH_ZHIMI_CAS_BASE` | Zhimi CAS 服务地址 | `https://cas.zhimi.com` |

至少配置一组 OAuth Provider 的 Client ID/Secret 即可启用对应的登录方式。

### 开发

```bash
npm run dev
```

使用 `tsx watch` 热重载开发模式，监听 `src/` 目录变更自动重启。

### 构建 & 生产运行

```bash
npm run build
npm start
```

### 代码质量

```bash
npm run lint      # OxLint 静态检查
npm run format    # Prettier 格式化
```

## 路由说明

| 路由 | 方法 | 说明 |
|------|------|------|
| `/gateway/login` | GET | 登录页面（展示可用 OAuth Provider） |
| `/gateway/auth/:provider` | GET | 发起 OAuth2 授权流程 |
| `/gateway/auth/:provider/callback` | GET | OAuth2 回调，完成登录 |
| `/gateway/logout` | POST | 注销登录 |
| `/gateway/status` | GET | 当前登录状态（JSON） |
| `/health` | GET | 健康检查 |
| `/*` | ALL | 认证后反向代理到用户 AionUi 实例 |

## 工作流程

1. 用户访问 Gateway，未认证时重定向到 `/gateway/login`
2. 用户选择 OAuth Provider 登录，完成授权码交换
3. Gateway 创建/查找本地用户记录，写入 Cookie Session
4. 后续请求通过 `requireAuth` 中间件验证后，由 `resolveInstance` 中间件为用户分配 Docker 容器
5. 容器启动后，Gateway 调用实例的 `gateway-login` API 完成内部认证
6. 所有 HTTP/WebSocket 请求透明代理到用户的容器实例
7. 空闲检测器每 60 秒扫描，超过 `INSTANCE_IDLE_TIMEOUT` 未活动的容器自动回收

## License

Private
