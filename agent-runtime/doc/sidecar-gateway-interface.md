# Sidecar ↔ Gateway 接口契约 v1

> Agent Runtime 标准接口规范。任何符合本契约的 Gateway 均可与 agent-runtime Sidecar 对接。

---

## 概述

| 项目 | 值 |
|------|-----|
| **协议版本** | `1` |
| **传输** | HTTP/JSON |
| **认证** | Sidecar→Gateway: Bearer Token；Gateway→Sidecar: 无认证（信任容器网络） |

通信方向分两类：

- **Sidecar → Gateway**（主动上报）：注册、心跳、注销
- **Gateway → Sidecar**（被动查询）：健康检查、能力发现

---

## 1. 认证

### Sidecar → Gateway

所有请求携带：

```
Authorization: Bearer {GATEWAY_SECRET}
Content-Type: application/json
```

`GATEWAY_SECRET` 由容器启动时环境变量注入，Gateway 负责校验。

### Gateway → Sidecar

Sidecar 暴露的 HTTP 端点（`/health`、`/info`）**不做认证**，依赖容器网络隔离（Docker network / K8s Pod network）保障安全。

> 如需在非隔离网络中部署，实现方可自行在 Sidecar 端添加认证中间件，但本契约不做强制要求。

---

## 2. Sidecar → Gateway 接口

### 2.1 注册 — `POST /api/internal/register`

**触发时机**：Sidecar 启动后，Runtime 进程就绪之后、心跳定时器启动之前。

#### Request Body

```json
{
  "protocolVersion": 1,
  "agentId": "agent-xxxxx",
  "transport": "stdio",
  "version": "1.0.0",
  "capabilities": {
    "healthEndpoint": true,
    "infoEndpoint": true,
    "heartbeat": true,
    "configReload": true
  },
  "endpoints": {
    "health": "/health",
    "info": "/info"
  },
  "runtime": {
    "cli": "opencode",
    "args": "acp"
  },
  "timestamp": 1712483200000
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `protocolVersion` | number | 是 | 接口契约版本号 |
| `agentId` | string | 是 | Agent 唯一标识 |
| `transport` | string | 是 | 通信模式：`"stdio"` 或 `"gateway"` |
| `version` | string | 是 | Sidecar 版本号（来自 package.json） |
| `capabilities` | object | 是 | Sidecar 支持的能力集 |
| `endpoints` | object | 是 | Sidecar 暴露的 HTTP 端点路径 |
| `runtime` | object | 是 | 容器内运行的 Runtime CLI 信息 |
| `timestamp` | number | 是 | 注册时间戳（ms） |

#### Response

| 状态码 | 含义 |
|--------|------|
| `200` | 注册成功 |
| `401` | 认证失败 |
| `409` | agentId 已注册（重复注册） |
| `5xx` | 服务端错误 |

成功响应体：

```json
{ "ok": true }
```

#### 重试策略

| 参数 | 值 |
|------|-----|
| 最大重试次数 | 3 |
| 退避策略 | 指数退避：0s → 2s → 4s |
| 失败处理 | 打印 warn 日志，**不阻塞 Sidecar 启动** |

> 如果收到 SIGTERM 信号，应立即终止重试循环。

---

### 2.2 心跳 — `POST /api/internal/heartbeat`

**触发时机**：周期性发送，默认每 30 秒一次。

#### Request Body

```json
{
  "agentId": "agent-xxxxx",
  "timestamp": 1712483200000,
  "status": "healthy",
  "metrics": {
    "cpu": 12.34,
    "memory": 67108864,
    "memoryDetail": {
      "rss": 67108864,
      "heapTotal": 33554432,
      "heapUsed": 20971520,
      "external": 1048576
    },
    "requests": 42,
    "uptime": 123.456,
    "loadAvg": [1.5, 1.2, 0.9]
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | Agent 唯一标识 |
| `timestamp` | number | 是 | 上报时间戳（ms） |
| `status` | string | 是 | 健康状态：`"healthy"` / `"error"` / `"unhealthy"` |
| `metrics` | object | 是 | 运行指标 |
| `metrics.cpu` | number | 是 | CPU 使用率（%，基于 `process.cpuUsage()` 差值计算） |
| `metrics.memory` | number | 是 | RSS 内存使用量（bytes） |
| `metrics.memoryDetail` | object | 否 | 详细内存分项 |
| `metrics.memoryDetail.rss` | number | 否 | Resident Set Size（bytes） |
| `metrics.memoryDetail.heapTotal` | number | 否 | V8 堆总量（bytes） |
| `metrics.memoryDetail.heapUsed` | number | 否 | V8 堆已用（bytes） |
| `metrics.memoryDetail.external` | number | 否 | V8 外部内存（bytes） |
| `metrics.requests` | number | 是 | Sidecar HTTP 请求累计计数 |
| `metrics.uptime` | number | 是 | 进程运行时长（秒） |
| `metrics.loadAvg` | number[] | 否 | 系统 1/5/15 分钟负载均值 |

#### Response

| 状态码 | 含义 |
|--------|------|
| `200` | 接收成功 |
| `401` | 认证失败 |
| `404` | agentId 未注册（Gateway 可选择接受或拒绝未注册的心跳） |
| `5xx` | 服务端错误 |

#### 错误处理

- 发送失败仅打印错误日志，不中断 Sidecar
- 下一个 interval 继续尝试

---

### 2.3 注销 — `POST /api/internal/deregister`

**触发时机**：Sidecar 收到 SIGTERM/SIGINT 后，在停止心跳和 Runtime 之前调用。

#### Request Body

```json
{
  "agentId": "agent-xxxxx",
  "reason": "shutdown",
  "timestamp": 1712483200000
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | Agent 唯一标识 |
| `reason` | string | 是 | 注销原因，当前固定为 `"shutdown"` |
| `timestamp` | number | 是 | 注销时间戳（ms） |

#### Response

| 状态码 | 含义 |
|--------|------|
| `200` | 注销成功 |
| `401` | 认证失败 |
| `404` | agentId 未找到 |
| `5xx` | 服务端错误 |

成功响应体：

```json
{ "ok": true }
```

#### 超时与错误处理

| 参数 | 值 |
|------|-----|
| 超时 | 5 秒 |
| 重试 | 不重试（单次尝试） |
| 失败处理 | 打印 warn 日志，**不阻塞 Sidecar 关停** |

---

## 3. Gateway → Sidecar 接口

### 3.1 健康检查 — `GET /health`

**用途**：Docker HEALTHCHECK / K8s liveness probe / Gateway 存活探测。

#### 端口

`HEALTH_PORT` 环境变量，默认 `3000`。

#### Response

**成功（200）**：

```json
{
  "status": "healthy",
  "agentId": "agent-xxxxx",
  "uptime": 123.456
}
```

**失败（503）**：

```json
{
  "status": "error",
  "agentId": "agent-xxxxx",
  "uptime": 123.456
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | string | `"healthy"` / `"error"` / `"unhealthy"` |
| `agentId` | string | Agent 标识 |
| `uptime` | number | Sidecar 进程运行时长（秒） |

#### 状态判定

| 状态 | HTTP Code | 条件 |
|------|-----------|------|
| `healthy` | 200 | Sidecar running 且 Runtime 进程存活 |
| `error` | 503 | Runtime 进程不存在或已终止 |
| `unhealthy` | 503 | Sidecar 自身未处于 running 状态 |

---

### 3.2 能力发现 — `GET /info`

**用途**：让 Gateway 了解 Sidecar 的版本、能力、运行状态，实现自动发现与兼容性判断。

#### 端口

与 `/health` 共享同一端口（`HEALTH_PORT`，默认 `3000`）。

#### Response（始终 200）

```json
{
  "protocolVersion": 1,
  "agentId": "agent-xxxxx",
  "version": "1.0.0",
  "transport": "stdio",
  "uptime": 123.456,
  "runtime": {
    "cli": "opencode",
    "args": "acp"
  },
  "capabilities": {
    "healthEndpoint": true,
    "infoEndpoint": true,
    "heartbeat": true,
    "configReload": true
  },
  "status": "running"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `protocolVersion` | number | 接口契约版本号 |
| `agentId` | string | Agent 唯一标识 |
| `version` | string | Sidecar 版本号 |
| `transport` | string | 通信模式：`"stdio"` / `"gateway"` |
| `uptime` | number | 进程运行时长（秒） |
| `runtime` | object | Runtime CLI 信息 |
| `runtime.cli` | string | CLI 命令 |
| `runtime.args` | string | CLI 参数 |
| `capabilities` | object | 支持的能力集 |
| `status` | string | 生命周期状态：`"running"` / `"shutting_down"` / `"stopped"` |

> **注意**：`status` 字段与 `/health` 的 `status` 含义不同。`/health` 回答"Runtime 是否可用"，`/info` 回答"Sidecar 处于什么生命周期阶段"。

---

### 3.3 配置热更新 — `POST /config-reload`

**用途**：Gateway 更新了宿主机上的配置文件后，通知 Sidecar 重启 Runtime 进程以加载新配置。

#### 端口

与 `/health`、`/info` 共享同一端口（`HEALTH_PORT`，默认 `3000`）。

#### 认证

**需要 Bearer Token**（与 Sidecar → Gateway 认证使用同一个 `GATEWAY_SECRET`）：

```
Authorization: Bearer {GATEWAY_SECRET}
```

无 token 或 token 不匹配时返回 `401`。

#### Request

```
POST /config-reload
Authorization: Bearer {GATEWAY_SECRET}
```

无需 request body（Sidecar 直接重新加载已通过 bind mount 同步的配置文件）。

#### Response

**成功（200）**：

```json
{ "ok": true, "message": "Runtime reloaded" }
```

**认证失败（401）**：

```json
{ "ok": false, "error": "Unauthorized" }
```

**重启失败（500）**：

```json
{ "ok": false, "error": "Failed to start runtime: ..." }
```

#### 副作用

| 影响 | 说明 |
|------|------|
| Runtime 进程重启 | 当前 Runtime 进程被 SIGTERM 终止后重新 spawn |
| WebSocket 连接断开 | stdio 模式下 ACP Bridge 重建，已连接客户端收到 WS close |
| Session 失效 | 客户端需要重新 `initialize()` → `session/new()` |
| Crash 计数器重置 | 主动重启不计入 crash restart 次数 |
| Workspace 不受影响 | 代码变更通过 bind mount 保留 |

#### 典型使用流程

```
1. Gateway 更新宿主机 opencode.json（bind mount 自动同步到容器内）
2. Gateway POST :3000/config-reload
3. Sidecar 停止旧 Runtime → 启动新 Runtime（读取新配置）
4. Sidecar 返回 200 { ok: true }
5. 客户端检测到 WebSocket 断开，重连后重新 initialize + session/new
```

---

## 4. 生命周期时序

```
容器启动
  │
  ▼
Sidecar.start()
  ├── 1. 启动 Runtime（stdio / gateway）
  ├── 2. POST /api/internal/register       ← 向 Gateway 注册
  ├── 3. 启动心跳定时器
  └── 4. 启动 HTTP 服务 (:3000)
         ├── GET /health
         ├── GET /info
         └── POST /config-reload
  │
  ▼ 运行中
  │  ├── 每 N 秒 POST /api/internal/heartbeat
  │  ├── GET /health 响应探测
  │  ├── GET /info 响应发现查询
  │  └── POST /config-reload 触发配置热更新
  │         └── reloadRuntime(): 停止 Runtime → 重启 Runtime
  │            （客户端 WS 断开，需重新 initialize + session/new）
  │
  ▼ SIGTERM / SIGINT
  │
Sidecar.stop()
  ├── 1. POST /api/internal/deregister     ← 向 Gateway 注销
  ├── 2. 停止心跳
  ├── 3. 关闭 HTTP 服务
  └── 4. 停止 Runtime
```

---

## 5. 优雅降级

当 Gateway 不支持某个接口时，Sidecar 的行为：

| 场景 | Sidecar 行为 |
|------|-------------|
| Gateway 不实现 `/api/internal/register` | 注册收到 404，重试 3 次后 warn 日志，正常启动 |
| Gateway 不实现 `/api/internal/deregister` | 注销收到 404 / 超时，warn 日志，正常关停 |
| Gateway 不实现 `/api/internal/heartbeat` | 心跳收到 404，error 日志，不影响 Sidecar 运行 |
| Gateway 完全不可达 | 所有上报失败，Sidecar 独立运行，仅被动响应 /health、/info、/config-reload |
| Gateway 不调用 `/config-reload` | Sidecar 正常运行，配置变更不会自动生效（需要手动重启容器） |

**设计原则**：Sidecar 不依赖 Gateway 的存在也能独立运行。注册/心跳/注销均为 best-effort。

---

## 6. 版本演进

- `protocolVersion` 字段用于契约版本协商
- Gateway 应检查注册请求中的 `protocolVersion`，如不支持则返回 `400`
- 未来新增接口时递增 `protocolVersion`，并在 `capabilities` 中声明新能力
- 旧版 Sidecar 的注册请求不包含新字段，Gateway 应做兼容处理

---

## 7. 环境变量汇总

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `AGENT_ID` | `default` | Agent 标识（所有接口均使用） |
| `GATEWAY_URL` | `http://gateway:3000` | Gateway 地址（注册/心跳/注销的目标） |
| `GATEWAY_SECRET` | （空） | Bearer Token（Sidecar→Gateway 认证） |
| `HEARTBEAT_INTERVAL` | `30000` | 心跳间隔（ms） |
| `HEALTH_PORT` | `3000` | Sidecar HTTP 端口（/health + /info） |
| `TRANSPORT_MODE` | `stdio` | 通信模式 |
