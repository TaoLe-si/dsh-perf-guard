# dsh-perf-guard

DSH（DeepSeek Harness）的长会话体验插件：**贴底跟随、思考链自动展开、截断/传输失败重试、待办常驻、离屏降载**。

只改行为，**不改任何主题、配色或布局**。

## 功能

### 1. 自动跟随（默认开）

- 贴底时，新内容到达后用 rAF 缓动追到最新一行（每帧逼近 45%），不是瞬移。
- 向上滚动（滚轮 / PageUp↑ / 拖动滚动条）立即脱离；内容重排、浏览器滚动锚定**不会**被误判成用户上滚。
- 回到底部 24px 内自动恢复跟随。
- 跟随中若宿主自己已脱离（渲染了「回到底部」按钮），点它一次让宿主的 `followingTail` 状态机自愈，节流 900ms。
- 阅读态（非贴底）**绝不**写 `scrollTop`，也不会点「回到底部」。

### 2. 思考链自动展开（默认开）

- 只展开正在流式输出的思考行（`[data-variant="think"][data-state="running"]`）。
- 过程组折叠时思考行不在 DOM 里：先用 `[data-streaming] / [data-shimmer]` 判断"正在输出"，再展开最新的过程组。
- 历史回合保持折叠；用户手动收起过的行记入 `WeakSet`，不再自动打开。

### 3. 截断 / 传输失败重试（默认开，可配）

| 类别 | 识别方式 | 默认 |
| --- | --- | --- |
| HTTP 400 / 401 / 402 / 403 | `LlmError.status` 或消息前缀 | 只记日志 |
| HTTP 429 / 502 / 503 | 同上 | 重试 |
| HTTP 500 / 504 | 同上（需在设置里打开） | 重试 |
| `TRANSPORT` / `STREAM_*` / `TIMEOUT` / `ETIMEDOUT` | 错误码或消息（含 `Request timed out.`、`stream idle timeout`） | 重试 |
| 上游空转 | 强信号「没有产出 / 空响应 / no output / empty completion」；弱信号「稍后重试」须同时出现 上游/网关/中转/超时 语境 | 重试 |
| 静默截断 | 流结束但没有 `finish` chunk | 重试 |
| 长度截断 | `finish.reason.stopReason` 命中 `length/max_tokens/max_output` | 重试并记录 |

- 上限 0–50，或**不限**（`maxRetries = -1`）。
- HTTP 状态类默认只在**本轮尚未输出内容**时重试。例外：网关类 `500/502/503/504` 若在**流到一半**时返回
  （Cloudflare 就是这样把 502 塞进流里的），在「截断 / 传输中断重试」开关打开时也允许重试，
  因为半截输出没有价值。⚠️ 已交付给调用方的增量**收不回来**，所以重试后正文可能先出现
  被中断的半截、再接完整内容；不想这样就把该开关关掉。429 与 4xx 保持"已输出后不重试"。
- `ABORTED` / `CANCELLED`（用户取消）永不重试；429 优先 `Retry-After`，其余指数退避（0.8s 起，封顶 15s）。
- 服务端在正文里给出的等待提示（`"retry_after":60`、`Retry-After: 5`）也会被读出来参与退避，
  但仍受 15s/30s 封顶约束——所以 Cloudflare 要求的 60s 实际会压到 30s。
- ⚠️ 长度截断重试通常仍会截断，根治是把该模型的 `maxTokens` 调大。
- 上游空转（如中转回 `上游 95 秒内没有产出，请稍后重试`）整轮零内容落地，重试不会产生重复输出；
  它受「截断 / 传输中断重试」开关控制。判定分两级，避免把 `余额不足，请稍后重试` 这类欠费错误也拉进重试：
  「没产出 / 空响应」本身即充分，「稍后重试」只有在同一句里出现上游/网关/超时语境时才成立。
  ⚠️ 若同时开了「不限」重试，而上游持续不产出，会持续重试下去（退避封顶 15s）。

### 4. 待办常驻面板（默认开）

- 数据源：`~/.dsh/storages/session_projcache/sessions/<sessionId>.json` 的 `todos.val`（与 UI 同源），日志解析作兜底。
- 渲染在 `shell.overlay` 常驻层：切会话、插入消息都不会消失；无待办时不占位。
- 按 `in_progress → pending → completed` 排序，完成项划线降透明；每会话 localStorage 缓存兜底。

### 5. 长会话降载（默认开）

- 离屏过程块 `content-visibility: auto`（整回合版本为实验项，默认关）。
- 工具输出限高并内部滚动。
- 滚动期间暂停动画与毛玻璃合成，停手 140ms 恢复。
- DOM > 12000 节点或 JS 堆 > 1.1GB 时自动切保守模式。

## 安装

```bash
# 从 GitHub 安装（无需发 npm）
dsh plugin --profile desktop add github:TaoLe-si/dsh-perf-guard

# 本地开发
dsh plugin --profile desktop add link:/absolute/path/to/dsh-perf-guard
```

手动安装：

```yaml
# <profile>/cordis.patch.yml 末尾
- insert:
    - id: perf-guard
      name: dsh-perf-guard
```

宿主半热重载；浏览器半需要刷新一次界面（Ctrl+R）。

## 设置

**设置 → 性能守卫**（`settings.section`，id `perf-guard`）：思考链与跟随、错误与重试（含状态码开关与「不限」）、自检（滚动容器/跟随状态/思考行计数/距底部）、会话日志体积排行。

开关存 `localStorage['dsh-perf-guard:prefs']`；重试配置存 `~/.dsh/perf-guard.retry.json`。

## 宿主接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/perf-guard/health` | 版本探活 |
| `GET /api/perf-guard/stats` | 宿主内存、会话日志排行、重试配置、最近错误 |
| `GET /api/perf-guard/todos?sessionId=` | 该会话待办快照 |
| `GET/POST /api/perf-guard/retry` | 读取/更新重试配置 |

除 `/assets/*` 外均要求 `x-dsh-plugin: perf-guard` 头。

## 兼容性

- 基线 `engines.dsh: ">=0.2.1-rc.4"`；低于基线的内核会被 DSH 直接禁用，无法挂载。
- DOM 契约来自 `@deepseek-ai/dsh-client-ui-chat@0.2.1-rc.4`，大版本升级需复核选择器。

## 测试

```bash
npm test
```

- `test/host-smoke.mjs`：状态码解析、退避、偏好归一化、重试中间件（429 重试 / 已输出不重试 / 传输中断重试 / 静默截断重试）。
- `test/follow-sim.mjs`：假 DOM 驱动真实跟随控制器，7 个场景。
- `test/client-smoke.mjs`：客户端装配冒烟。
- `test/fixture/follow.html`：真浏览器仿真（Edge headless，6 项断言）。

## 已知限制

- 长度截断（`max_tokens`）重试通常无效，应调大模型 `maxTokens`。
- 待办面板依赖投影缓存文件；缺失时退回会话日志解析。
- 仅做渲染层优化，不降低宿主解压会话日志的内存峰值。

## License

MIT