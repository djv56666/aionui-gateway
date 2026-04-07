# Sidecar 心跳上报与健康检查

> 源码位置：`agent-runtime/sidecar/agent-sidecar.js`

Sidecar 提供两套存活机制：**健康检查（Health Check）** 供 Docker / K8s 探测容器状态；**心跳上报（Heartbeat）** 主动向 Gateway 报告自身状态与指标。两者均在 `AgentSidecar.start()` 中启动。

---

## 1. 健康检查（Health Check）

### 1.1 概述

Sidecar 内置一个轻量 HTTP 服务，供 Docker HEALTHCHECK / K8s liveness probe 使用。

### 1.2 接口定义

| 项目 | 值 |
|------|-----|
| **端口** | `HEALTH_PORT` 环境变量，默认 `3000` |
| **路径** | `GET /health` |
| **成功状态码** | `200` |
| **失败状态码** | `503` |
| **Content-Type** | `application/json` |

### 1.3 响应体

```json
{
  "status": "healthy | error | unhealthy",
  "agentId": "<AGENT_ID>",
  "uptime": 123.456
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | string | 健康状态，取值见下方状态枚举 |
| `agentId` | string | 当前 Agent 标识（来自 `AGENT_ID` 环境变量） |
| `uptime` | number | Sidecar 进程运行时长（秒），来自 `process.uptime()` |

### 1.4 状态枚举

| 状态值 | HTTP Code | 含义 |
|--------|-----------|------|
| `healthy` | 200 | Runtime 进程正常运行 |
| `error` | 503 | Runtime 进程异常（进程不存在或已被 kill） |
| `unhealthy` | 503 | Sidecar 自身未处于 running 状态 |

### 1.5 健康判定逻辑

```
checkHealth()
├── isRunning == false  → "unhealthy"
├── transport == "gateway"
│   └── gatewayProcess 不存在 or 已 killed  → "error"
│   └── 否则                                → "healthy"
└── transport == "stdio"
    └── acpBridge 不存在                    → "error"
    └── 否则                                → "healthy"
```

- **stdio 模式**：检查 `AcpBridge` 实例是否存在
- **gateway 模式**：检查 `gatewayProcess` 是否存活且未被 kill

### 1.6 Docker HEALTHCHECK 配置

所有 Runtime 镜像 Dockerfile 中统一配置：

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
```

| 参数 | 值 | 说明 |
|------|----|------|
| `--interval` | 30s | 每 30 秒探测一次 |
| `--timeout` | 5s | 单次探测超时 5 秒 |
| `--start-period` | 10s | 容器启动后 10 秒内不判定为失败 |
| `--retries` | 3 | 连续 3 次失败后标记为 unhealthy |

### 1.7 其他路径

非 `/health` 路径返回 `404 Not Found`。

---

## 2. 心跳上报（Heartbeat）

### 2.1 概述

Sidecar 定时向 Gateway 上报心跳，携带自身健康状态和运行指标，供 Gateway 做容器生命周期管理。

### 2.2 上报目标

| 项目 | 值 |
|------|-----|
| **URL** | `{GATEWAY_URL}/api/internal/heartbeat` |
| **方法** | `POST` |
| **Content-Type** | `application/json` |
| **认证** | `Authorization: Bearer {GATEWAY_SECRET}` |
| **上报间隔** | `HEARTBEAT_INTERVAL` 环境变量，默认 `30000` ms（30 秒） |

### 2.3 请求体（Payload）

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

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | Agent 标识 |
| `timestamp` | number | 上报时间戳（`Date.now()`，毫秒） |
| `status` | string | 健康状态，同 `checkHealth()` 返回值 |
| `metrics` | object | 运行指标（见下方） |

### 2.4 Metrics 字段

| 字段 | 类型 | 采集方式 | 说明 |
|------|------|---------|------|
| `cpu` | number | `process.cpuUsage()` 差值 | CPU 使用率（%，相对于单核） |
| `memory` | number | `process.memoryUsage().rss` | RSS 内存使用量（bytes） |
| `memoryDetail.rss` | number | `process.memoryUsage()` | Resident Set Size（bytes） |
| `memoryDetail.heapTotal` | number | `process.memoryUsage()` | V8 堆总量（bytes） |
| `memoryDetail.heapUsed` | number | `process.memoryUsage()` | V8 堆已用（bytes） |
| `memoryDetail.external` | number | `process.memoryUsage()` | V8 外部内存（bytes） |
| `requests` | number | HTTP 请求计数器 | Sidecar HTTP 端口累计请求数 |
| `uptime` | number | `process.uptime()` | Sidecar 进程运行时长（秒） |
| `loadAvg` | number[] | `os.loadavg()` | 系统 1/5/15 分钟负载均值 |

### 2.5 错误处理

- 心跳发送失败（网络异常或非 2xx 响应）时打印错误日志，**不中断 Sidecar 运行**
- 下一个 interval 继续尝试发送

### 2.6 Gateway 端接收

> **当前状态**：Gateway 侧的 `/api/internal/heartbeat` 接口**尚未实现**。Sidecar 心跳上报逻辑已就绪，Gateway 端需要后续开发接收和处理心跳数据的能力。

---

## 3. 生命周期

```
容器启动
  │
  ▼
entrypoint.sh
  │
  ▼
index.js → new AgentSidecar(config)
  │
  ▼
sidecar.start()
  ├── startStdioMode() / startGatewayMode()   ← 启动 Runtime
  ├── register()                                ← 向 Gateway 注册（best-effort）
  ├── startHeartbeat()                          ← 启动心跳定时器
  └── startHealthServer()                       ← 启动 HTTP 服务（/health + /info + /config-reload）
  │
  ▼
运行中...
  │  ├── 每 30s 发送心跳 → Gateway
  │  ├── HTTP :3000/health 持续响应探测
  │  ├── HTTP :3000/info 响应能力发现查询
  │  └── POST :3000/config-reload 配置热更新（重启 Runtime）
  │
  ▼
收到 SIGTERM / SIGINT
  │
  ▼
sidecar.stop()
  ├── deregister()                              ← 向 Gateway 注销（best-effort）
  ├── clearInterval(heartbeatTimer)             ← 停止心跳
  ├── healthServer.close()                      ← 关闭 HTTP 服务
  └── stopStdioMode() / stopGatewayMode()       ← 停止 Runtime
```

---

## 4. 相关环境变量

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `HEALTH_PORT` | `3000` | 健康检查 HTTP 端口 |
| `HEARTBEAT_INTERVAL` | `30000` | 心跳上报间隔（ms） |
| `GATEWAY_URL` | `http://gateway:3000` | Gateway 地址（心跳上报目标） |
| `GATEWAY_SECRET` | （空） | Gateway 通信密钥（心跳认证） |
| `AGENT_ID` | `default` | Agent 标识（心跳和健康检查均携带） |

---

## 5. 调试与验证

### 手动测试健康检查

```bash
# 容器内
curl -s http://localhost:3000/health | jq .

# 容器外（假设端口映射为 13000:3000）
curl -s http://localhost:13000/health | jq .
```

### 查看 Docker 健康状态

```bash
docker inspect --format='{{.State.Health.Status}}' <container_id>
```

### 查看心跳日志

```bash
docker logs <container_id> 2>&1 | grep heartbeat
```

---

## 6. 相关文档

- **接口契约规范**：[sidecar-gateway-interface.md](sidecar-gateway-interface.md) — 定义了注册、心跳、注销、健康检查、能力发现共 5 个接口的完整契约，适用于对接任意 Gateway 实现。
