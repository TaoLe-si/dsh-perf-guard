# Changelog

## 1.9.5 完整模型目录

- 无筛选的 `list_subagent_models` 列出所有已注册提供方公布的模型，不依赖已有子代理。空字符串筛选也返回目录。
- 将宿主模型与会话授权路由分开显示。单个提供方查询失败不影响其他目录，明确指定模型仍由 DSH 校验。
- 宿主模块不再依赖安装目录里的 DSH 软件包来构造纠正消息。

## 1.9.4 空路由枚举结果

- `list_subagent_models` 成功但返回空提供方/模型时，也加入停止重复枚举的下一步上下文。
- 继续保留空参数失败的原始错误和纠正上下文。

## 1.9.3 子代理空参数恢复

- 空的 `provider` / `model` 参数失败时，下一步上下文明确禁止重放原调用。
- 如果当前会话没有可用子代理路由，提示停止枚举和重试；默认路由也不可用时直接完成当前任务。
- 仍保留原始工具错误、参数和授权结果，不伪造成功。

## 1.9.2 悬停详情

- 使用同一个单调时钟计量停稳时间，重新计时不丢失待展开的条目。
- 用确定性计时测试覆盖重复移动跨越原计时截止点的情况。

## 1.9.1 冷会话缓存和市场发布

- 移除未发布的后台任务清理逻辑，不处理任务生命周期。
- 提供原生冷会话缓存限额的可选示例，不在安装时覆盖已有的搜索配置。正在读取的历史不淘汰，持久化历史不变。
- 宿主诊断区分空闲与运行中的 Agent；诊断和设置接口使用 DSH 的 owner 认证。
- 补充安装、升级、隐私说明、中英文市场简介和插件图标。

## 1.8.0 — DSH 0.2.2 兼容

- 新版 Chat 由 DSH 管理跟随和历史锚点。插件不再代点「回到底部」；旧版小幅上滚后也保持阅读，直到实际回底。
- 思考区自动展开仅限所在对话贴底时，避免不可见的过程组标题抢焦点。
- 子代理路由被拒绝时附恢复提示，不修改会话授权或代为重试。
- `CONTENT_REFUSED` 保持为拒答，不由插件当作传输中断重试。

## 1.7.0 — 侧边栏「悬停详情」防抖

### 卡顿成因（读源码定位，非猜测）

会话行用的是 `@deepseek-ai/dsh-client-ui-primitives` 的 `Tooltip`，它的 `delayMs` **默认为 0**：
指针一进入行就立刻

1. `el.getBoundingClientRect()` —— 强制同步布局；
2. 挂载气泡（`ResizeObserver` + 定位 `useEffect`，写 `left/top` 再触发一次布局）；
3. 指针离开时整棵卸载。

所以「滑过列表」等于逐行做「布局 → 挂载 → 测量 → 卸载」。扫过十几行就是十几次布局抖动。

### 修复

- **悬停防抖（hover intent）**：在 `[role="tree"]`（会话列表）范围内，把**指针移动期间**的
  `pointerover` / `pointerout` 拦下来（document 捕获阶段，早于 React 的委托监听），
  指针停稳 **140ms** 后补发一次成对的 `out`/`over`，详情卡片在停稳后出现。
  这等于补上了 `Tooltip` 缺失的 `delayMs` 语义，且不需要改 `app.asar`。
- **拖动放行**：`event.buttons !== 0` 时一律透传（gutter 多选、拖拽都依赖 `pointerenter`）。
- **气泡层 CSS 约束**：`[role="tooltip"] { contain: layout paint; will-change: transform }`，
  把它的布局/绘制限制在自身，写 `left/top` 时不必重绘列表背景。
- 设置页新增「悬停详情防抖」开关（默认开）。

### 测试

新增 `test/hover-intent.mjs`（最小 DOM）：移动中被拦、停稳后补发、拖动放行、树外不拦、关开关不拦。
全套 83 项通过。

## 1.6.0 — 修复重试导致堆内存耗尽崩溃

### 事故成因（三因素叠加）

1. 设置页的「不限次数」（`maxRetries: -1`）是真的不限：`shouldRetry` 里 `maxRetries < 0` 直接跳过次数判定。
2. 同一页把 **HTTP 400 / 401 / 403** 也设成可重试 —— 这类**永久性错误重试永远不会成功**。
3. 每次重试都要重建完整请求与流，宿主侧会话状态只增不减。

三者叠加后：一个必然失败的错误被无限重试，堆内存单调上涨，最终 OOM 崩溃。
实测本机偏好文件正是 `maxRetries: -1` + `400/401/403: true`。

### 修复

- `SAFETY_MAX_ATTEMPTS = 8`：`-1` 只表示「不受用户设定次数限制」，**仍受硬封顶**；流级与 agent 级共用同一预算函数 `retryBudgetOf()`。
- `PERMANENT_STATUSES`（400/401/402/403/404/405/422）：**结构上禁止重试**，配置里开着也不认；`normalizePrefs` 加载时强制关闭，旧配置自动纠正。
- **堆压力熔断**：`heapUsed / heap_size_limit ≥ 0.85` 时拒绝再重试——内存吃紧时重试就是把「慢」变成「崩」。
- 加载时显式 `console.warn` 列出被收敛的配置项，不静默改写用户设置。
- 设置页：移除「不限」开关，次数输入 0–8 硬边界；400/401/402/403 开关置为禁用态并说明原因。
- `Switch` 组件支持 `disabled`。

### 测试

- 新增：永久性错误即使配置打开也不重试；`normalizePrefs` 强制关闭永久状态；`-1` 受安全上限封顶。
- 改写两条**锁定旧危险行为**的断言（4xx 可重试、`-1` 无限）。
- 全套 78 项通过：host-smoke 46 · host-contract 24 · follow-sim 7 · client-smoke 1。

## 1.5.0

针对「多轮长任务卡顿」和「堆内存吃紧」的优化。

- **宿主：堆压力遥测与告警**。长会话卡顿的主因不是 RSS，而是 **V8 堆接近上限**——堆快满时
  major GC 会频繁打断单线程事件循环，所有会话一起停帧。`/api/perf-guard/stats` 的 `host` 段新增：
  `heapLimit`（`v8.getHeapStatistics().heap_size_limit`）、`heapPressure`（heapUsed/limit）、
  `heapHeadroom`、`heapPressureWarn`。压力 ≥85% 时告警一次，并给出可直接照做的配方
  （`NODE_OPTIONS=--max-old-space-size=N`）。**堆上限启动后不可改**，所以这是唯一可行的路径。
- **客户端：长会话自动开整回合离屏跳过**。原来「整回合离屏」是实验开关、默认关；现在回合数
  ≥ 20 自动开启（手动开关仍可覆盖）。这是长任务渲染开销最大的一项。
- **客户端：占位高度自适应**。离屏跳过用 `contain-intrinsic-size` 占位，原来固定猜 360px，
  实际高度差很多时浏览器会反复校正滚动位置（表现为滚动发飘/卡顿）。现在采样已渲染回合的平均
  高度写进 `--dsh-pg-turn-size`，占位与真实高度对齐。
- **客户端：降载阈值改为按真实堆上限算**。原来写死 1.1GB，现在取
  `performance.memory.jsHeapSizeLimit × 0.7`（取不到时退回 1.1GB），不同机器/会话都能自适应。

## 1.4.2

- **修复 `Assistant stream chunk must be losslessly JSON-serializable`**（1.4.1 引入）。
  摘 replayState 时写成了 `{ ...chunk, replayState: undefined }`，这会留下一个**键存在、值为
  `undefined`** 的自有属性；`JSON.stringify` 会把这个键丢掉，往返不再无损，
  宿主 `snapshotJsonValue` 判定为非无损 JSON 直接抛错。现在改为**整个键剔除**
  （解构剩余属性重组），chunk 依旧是纯 JSON。
- 新增一条防御性用例：keep / strip 各场景下逐个检查下发 chunk 的无损性，
  既查 `undefined` 值，也查「序列化后会消失的键」（symbol / 不可枚举键）。

## 1.4.1

修掉 1.4.0 引入的两个问题（keep 模式的影响面比预期大）：

- **改写块结构后必须摘掉 `replayState`**。纯思维链的块被改写成 reasoning 块后**块数仍是 1**，
  `assembled()` 的 `envelope.blocks.length === all.length` 判定会误以为 replay 仍可用，
  于是把不适用的 replay 保留下来，pi-ai 在下一轮校验时报
  `unusable replay state on assistant history ... block 0 does not match assistant content`
  （实测 jiuge/deepseek-flash 35 次）。现在只要本插件真的重组过块，就把 finish 上的
  `replayState` 摘掉——描述不到新消息的 replay 留着只会误导适配器。
- **空的 text 块不再丢 `block-start`**。keep 模式延迟下发 block-start（避免纯思维链块产生空正文块），
  但块里一个字节都没有时不会补回来，导致落盘 chunk 流少一个 block-start。现在在 `block-end`
  前把原始 block-start 补上（用适配器原对象，保留全部字段）。

## 1.4.0

**正文思维链改为「保留」：改写成真正的 reasoning 块，而不是丢弃。**

- 三态 `thinkingMode`：`keep`（默认，保留并折叠显示）/ `strip`（丢弃）/ `off`（原样打印）。
  1.3.0 的布尔字段 `stripThinking` 自动迁移（`false` → `off`）。
- **为什么要重组块，而不是只改增量**：`BlockAssembler.assemble()` 里 `if (partial.block) return partial.block`，
  适配器结尾的 `block-end` 带着整块原文，会覆盖已累积的 deltas。所以 keep 模式把 text 块的
  `block-start`/`block-end` 一起接管，按片段重新开块（`reasoning-delta` + 自建块序号）。
- **没遇到标签时完全透传**：原生块、序号、`block-end` 一律原样下发（用例断言字节级一致）。
  这一点很重要——`assembled()` 要求 `envelope.blocks.length === all.length` 才保留 `replayState`，
  透传能保证绝大多数正常消息的 replay 不被无辜降级。只有真的出现思维链标签、块数变化时，
  DSH 才会自动丢弃该轮 replayState（内容不受影响）。
- 未闭合的 `<thinking>` 也按 reasoning 保留，不会再混进正文块。
- 设置页「输出清理」改为两个开关（处理 / 保留为可折叠思考）。

> ⚠️ 边界：只能处理**带标签**的思维链。如果渠道直接把推理文本写进正文、完全不带标签，
> 这一层无法可靠区分它与正常输出（任何启发式都会误伤正文），需要从 provider/模型侧解决。

## 1.3.0

- **新功能：过滤正文里的思维链**。有些渠道/模型不走 reasoning 通道，而是把思维链**原样当正文**吐出来，
  界面上就直接打印成一堆 `<thinking>Now let me read the Flutter navigation…`。现在在 `llm/stream`
  出口就摘掉，不写进 assistant 消息、也不占后续上下文：
  - 识别 `<thinking>` / `<thought>` / `<reasoning>`（大小写不敏感），正则收得很窄，不误伤正文与代码块里的尖括号；
  - **跨 chunk 切割**的标签也能认（`<thi` + `nking>`）：未决断的尾巴扣在 pending 里，等下一个 chunk 一起判；
  - **两处都洗**：增量 `text-delta` 与 `block-end`。后者是必须的——assembler 里 `block-end` 会
    `partial.block = chunk.block` 整块覆盖已累积的 deltas（`assemble(): if (partial.block) return partial.block`），
    只过滤增量的话最终消息仍是原文；
  - 未闭合的 `<thinking>` 在 `flush` 时整段丢弃并复位状态，避免把后续正文无限吞掉；
  - 整段都是思维链时不往下游吐字节，因此 `emitted` 保持 false——这种情况下重试仍然是安全的。
  - 设置页新增「输出清理」分组与开关（`stripThinking`，默认开）；命中字符数计入 `/api/perf-guard/stats` 的 `thinking.strippedChars`。
- 新增 7 条用例：摘除规则、不误伤正文、未闭合处理、跨 chunk 切标签、flush 交还尾巴、流级端到端（增量 + block-end + finish）、关闭开关后原样放行。
- 顺带加了 `resetPrefsCache`（丢掉偏好的内存缓存，便于测试与热更新后强制重读配置）。

## 1.2.1

- **并发上限纳入重试**。实测形态（宿主日志）：

  ```
  perf-guard: LLM UNKNOWN PI_AI_ERROR · anliang/gpt-6.1-terra · attempt 1 ·
    Concurrency limit exceeded for user, please retry later
  ```

  也就是 `code=PI_AI_ERROR`、**没有 HTTP 状态码**、`kind=unknown`。它既不含 `TRANSPORT` 关键词，
  「稍后重试」这条弱信号又缺少上游/超时语境，于是整类被判成 `unknown` 直接放行、从不重试。
  现在「并发上限」和「账号池繁忙」一样按**强信号**判为瞬时拥塞（等同账号其它请求跑完就会放行）：
  命中 `Concurrency limit exceeded` / `too many concurrent` / `max concurrent requests` /
  `并发上限` / `同时请求过多` 等即重试，受同一「截断 / 传输中断重试」开关与上限控制。
  仍然刻意**不**认泛化的 `PI_AI_ERROR` —— 那会把这一层变成「任何 pi-ai 错误都重试」，
  在 `maxRetries = -1` 下足以打成死循环。
- **拥塞类退避单独调慢**：并发上限 / 账号池繁忙从 0.8s 起步改成 **2s 起步**（与 429 同档，仍指数增长并封顶 15s）——
  0.8s 时几乎必然和那个正占用并发额度的请求复撞。agent 层退避也复用同一口径，并读正文里的 `retry_after`。
- 新增 4 条回归用例（分类矩阵、agent 层决策含策略退避、流级重试端到端、拥塞类退避档位）。

## 1.2.0

**适配 DSH 0.2.2-rc.1，同时继续支持 0.2.1-rc.4（同一份代码，能力探测而非版本号判断）。**

- **修复致命 bug：重试反而让整个回合失败（`next() called multiple times`）**。
  0.2.2-rc.1 的 cordis 把 `llm/stream` 的 `next` 做成**一次性**的
  （`lib/index.js`：`if (called) throw new Error('next() called multiple times')`），
  而流级重试的实现是「回到循环顶部再 `next()` 一次」。于是**每一次流级重试都必然抛错**，
  把一个本可重试的传输失败升级成回合级失败。宿主日志实测：

  ```
  perf-guard: LLM TRANSPORT TRANSPORT · yueka/deepseek-v4.1-flash · attempt 1 · Connection error.
  perf-guard: retry 1/inf in 800ms after transport (partial output discarded)
  perf-guard: LLM UNKNOWN · yueka/deepseek-v4.1-flash · attempt 2 · next() called multiple times
  [host.agent] agent.failed {"message":"next() called multiple times"}
  ```

  现在重试不再二次调用 `next()`，而是带上 `Symbol.for('dsh-perf-guard.layered-retry')` 标记
  **重新进入 `llm.stream()`**（waterfall 从最外层重跑，本中间件认出标记后只透传，不会套娃）。
  另外补一条兜底：万一拿不到 `llm` 服务导致内核仍抛该错，就把**上一次的原始失败**交回上层
  （由 `agent/request-error` 的重试接手），绝不把内核内部错误暴露成回合失败。

- **修复（会静默丢失重试的一处硬伤）**：新版把 `agent/request-error` 变成一个真正的 waterfall，
  agent loop 只取**最外层 listener** 的返回值：

  ```
  const action = await dispatch.waterfall('agent/request-error', {...}, () => Promise.resolve(void 0))
  if (action?.kind !== 'retry') throw new LlmError(...)
  ```

  旧实现命中判据就 `return { kind: 'retry' }`、不命中就 `return next()`。在新版里 `next()`
  下游坐着原生 `@deepseek-ai/dsh-llm-retry`，"不命中"时我们返回的 `undefined` 会把**原生做出的重试决定吞掉**。
  现在统一 `await next()` 并把下游结论原样向上传；对旧版（`next()` 恒为 `() => Promise.resolve(undefined)`）是空操作。
- **不再与原生 llm-retry 抢着重试**：新版载荷带 `retryPolicy`（provider 注册时解析的
  `{ mode, maxRetries, retryableCodes, backoff }`）。若某失败 code 属于 `retryableCodes`（或 `mode: 'always'`），
  说明原生已接管：它此刻没给 retry 就是策略不允许或预算耗尽，本插件不再加码——避免双重退避、绕开 provider 的 `maxRetries`。
  新开关 `respectNativePolicy`（默认 `true`）可关掉这条让位规则。
- **认新版归一化失败码**：`TRANSPORT` / `TIMEOUT` / `EMPTY_RESPONSE` 归入传输类（可整段重试）；
  `RATE_LIMIT` → 429、`SERVER` → 502，直接复用已有的「按状态码开关」。旧版只有 `PI_AI_ERROR` 这类原始码，走原有正文分类，行为不变。
- **修复截断告警在升级后静默失效**：新版 finish reason 是判别式 `kind: 'max-tokens'`，旧实现只匹配
  `stopReason` 文案里的 `length/max_tokens`，两边都对不上。现在两种形态都认。
- **修复输出字数统计恒为 0**：新版文本增量字段是 `text`（旧版 `delta`），两个都认；影响截断日志里的字数。
- **退避交给 provider 策略**：有 `retryPolicy.backoff`（`initialDelayMs/maxDelayMs/jitterRatio`）时按它算并带抖动，
  缺失或非法时退回插件原有 0.8s 指数退避封顶 15s。
- **偏好保存改为合并**：浏览器半只提交它认识的字段，原来的整体替换会在每次保存时把新增偏好重置成默认值。
- `/api/perf-guard/stats` 新增 `contract` 段（是否探测到新版 `llm.providerRetryPolicy`、当前契约形态），
  宿主日志新增一行「LLM 契约 new/legacy」。
- **测试**：`test/host-contract.mjs` 新增 24 条（新契约探测/让位判定/策略退避/归一化码/决策矩阵/waterfall 两种注册顺序），
  `test/host-smoke.mjs` 新增 3 条单次-`next` 契约回归（含上面那个 bug 的最小复现）；
  `npm test` 现在会跑 `host-smoke + host-contract + follow-sim` 再接 client smoke，共 56 项。

## 1.1.1

- **账号池繁忙纳入重试**：`账号池繁忙，请稍后重试` 这类中转/号池排队错误过去只命中弱信号「稍后重试」、缺少上游语境而不重试；
  现在 `账号池 / 号池 / 繁忙 / 排队 / 拥挤 / overloaded / too many requests` 作为**强信号**直接判定为可重试的瞬时拥塞。
  反例仍不重试：`余额不足，请稍后重试`。

## 1.1.0

- **移除待办常驻面板**：按用户要求下线 `shell.overlay` 待办浮层、`GET /api/perf-guard/todos` 接口及其投影缓存/日志解析代码与相关测试。
  其余能力（跟随、重试、降载、设置页）不变。

## 1.0.5

- **上游输出中断纳入重试**：宿主把失败包成回合级错误（`本轮运行失败上游输出中断，请重试`）时，`llm/stream` 已经看不到它。
  现在同时挂 `agent/request-error`，命中传输/超时/截断类失败就返回 `{ kind: 'retry' }`，按 `provider:turn:step` 计次、指数退避（0.8s 起，封顶 15s），受同一「截断 / 传输中断重试」开关与重试上限控制。
- 错误分类补充中文关键字：`上游输出中断`、`输出中断`、`连接中断`、`中断，请重试`。

## 1.0.4

- **502 在流到一半时也会重试**：实测日志里 502 被正确识别为 `HTTP 502`，却没有对应的
  `retry … after HTTP` 行——因为旧规则要求"本轮尚未输出任何内容"才重试，
  而 Cloudflare 的 502 是夹在流中间返回的。现在网关类 `500/502/503/504` 在
  「截断 / 传输中断重试」开关打开时允许整段重试；`429` 与 4xx 的既有语义不变。
  ⚠️ 中间件是边收边转发的，已交付的增量收不回来，重试后可能先看到半截再看到完整内容。
- **读取正文里的 `retry_after`**：Cloudflare 的 502/503 正文带 `"retry_after":60` 与
  "back off for at least 60 seconds"，过去只有 pi-ai 抬上来的 `providerRetryAfterMs` 才被采用。
  现在从正文补一条兜底，但仍受既有封顶（15s/30s）约束，因此 60s 实际压到 30s。
- 重试判定抽成纯函数 `shouldRetry`，新增 7 个用例覆盖状态码 × 是否已输出 × 开关 × 上限矩阵。

## 1.0.3

- **上游空转纳入重试**：中转在长时间不吐 token 时会自己掐断并回一条中文错误，例如
  `上游 95 秒内没有产出，请稍后重试`。这条失败既没有 HTTP 状态码，也不含传输类关键词，
  过去落在 `unknown` 而被跳过——现在归入传输/截断同一类，受「截断 / 传输中断重试」开关控制。
  判定分两级：强信号「没有产出 / 空响应 / no output / empty completion」本身即充分；
  弱信号「稍后重试」必须同时出现 上游/网关/中转/超时 语境，否则 `余额不足，请稍后重试`
  这类欠费错误也会被无限重试。**不**认泛化的 `PI_AI_ERROR`。整轮零内容落地，因此重试不会产生重复输出。

## 1.0.2

- **超时纳入重试**：`TIMEOUT` / `ETIMEDOUT` / `Request timed out.` / `stream idle timeout` 现在与传输中断同属一类，受「截断 / 传输中断重试」开关控制（默认开）。
- 待办面板只在对话视图显示，不再漂浮在设置页等其他页面（1.0.1）。

## 1.0.0

首个对外版本。功能范围：

- **自动跟随**：贴底时平滑追到最新一行；向上滚动（滚轮 / 方向键 / 拖动滚动条）立即脱离；回到底部 24px 内自动恢复；
  跟随中若宿主已脱离，点击其「回到底部」让状态机自愈；阅读态不再干预滚动。
- **思考链自动展开**：仅展开正在流式输出的思考行，并先展开其外层过程组；历史回合保持折叠；手动收起后不再自动打开。
- **截断 / 传输失败重试**：识别 `finish_reason=length`、静默截断（无 finish）、`TRANSPORT` 与 HTTP 400/401/402/403/429/502/503；
  按状态码分别开关，上限 0–50 或「不限」；仅在本轮尚未输出内容时对 HTTP 状态重试，传输/截断允许整段重试；429 优先使用 `Retry-After`。
- **待办常驻面板**：读取投影缓存 `storages/session_projcache/sessions/<id>.json` 的 `todos.val`，
  以 `shell.overlay` 常驻层渲染，切换会话/插入消息不会丢失；本地 localStorage 缓存兜底。
- **长会话降载**：离屏过程块 `content-visibility`、工具输出限高、滚动期间暂停动画与毛玻璃、DOM/堆超阈值自动降载。
- **诊断**：`/api/perf-guard/health`、`/api/perf-guard/stats`、`/api/perf-guard/todos`、`/api/perf-guard/retry`。

不包含：任何主题、配色或布局改写（已按用户要求移除）。
