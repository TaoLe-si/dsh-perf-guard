# dsh-perf-guard

DSH（DeepSeek Harness）的**长会话性能守卫 + 阅读体验增强**插件。

长上下文、多轮会话、`transcriptView: verbose` 时，transcript 会把每一步工具调用都渲染成独立 DOM，
滚动时浏览器仍要为屏幕外的块做样式计算、布局与合成，于是越聊越卡；
默认折叠的思考链和「要不要跟到底部」的判断也在拖慢阅读节奏。

本插件只改**渲染与交互**，不动任何会话数据。

## 功能

### 滚动与渲染

| 能力 | 默认 | 说明 |
| --- | --- | --- |
| 离屏过程块跳过渲染 | 开 | `[data-step-process]` / `[data-turn-process]` 加 `content-visibility: auto` + `contain-intrinsic-size`，屏幕外的步骤不再付布局与绘制成本 |
| 整回合离屏跳过（实验） | 关 | 把上一条提升到整条 `[data-chat-turn]`。长会话收益最大；若滚动位置偶尔跳动就关掉 |
| 工具输出限高 | 开 | 回合内 `pre`、过程体限高并内部滚动，避免单条消息撑出几万像素 |
| 滚动期间降载 | 开 | 滚动时暂停动画/过渡、关掉 `backdrop-filter`，停手 140ms 后恢复 |
| 自动降载 | 开 | DOM > 12000 节点或 JS 堆 > 1.1GB 时自动切到整回合离屏跳过 |

### 思考链与跟随

| 能力 | 默认 | 说明 |
| --- | --- | --- |
| 自动展开思考链 | 开 | 只展开 `data-state="running"` 的思考行；过程组折叠时先展开最新回合的过程组，再展开思考行。历史回合保持折叠，避免 DOM 膨胀；手动收起过的行记入 WeakSet，不再自动打开 |
| 展开平滑动画 | 开 | 思考行/过程体展开时 180–200ms 淡入上移；`prefers-reduced-motion` 下自动取消 |
| 跟随最新输出 | 开 | 贴底时用 rAF 缓动追到最新一行（每帧逼近 30%）；向上滚动 >64px 立刻脱离；回到底部 24px 内自动恢复 |

跟随判定不看滚轮方向，只看 `scrollTop` 是否真的变小，所以「内容变高」不会被误判成用户上滚；
过程体/工具输出里的嵌套滚动也不会让主滚动条脱离跟随。

### 宿主诊断

- 每 30s 采样宿主 RSS，超过 2GB 打 warn（提前暴露 OOM 风险，不改变行为）。
- `GET /api/perf-guard/stats`：宿主内存 + `~/.dsh/sessions` 日志体积排行（60s 缓存，需要 `x-dsh-plugin: perf-guard` 头与正常登录态）。
- `GET /api/perf-guard/health`：版本探活。

## 设置页

插件注册了独立的设置页 **设置 → 性能守卫**（`settings.section` 槽，`id: perf-guard`），包含：

- 分组开关（思考链与跟随 / 滚动与渲染），即时生效；
- 实时指标：渲染进程 JS 堆、DOM 节点数、宿主 RSS、会话日志总量；
- 最大的会话日志排行（指出真正撑爆内存的会话）；
- 「立即采样」「恢复默认」。

开关持久化在 `localStorage['dsh-perf-guard:prefs']`。

## 安装

### 从 npm / 本地路径安装（推荐）

```bash
# 已发布到 npm 时
dsh plugin --profile desktop add dsh-perf-guard

# 本地开发（软链整个目录）
dsh plugin --profile desktop add link:/absolute/path/to/dsh-perf-guard
```

包内 `cordis.patch.yml` 会把宿主半挂成 `perf-guard` 一行；浏览器半由 `package.json` 的 `dsh.client` 自动进入客户端模块图。

### 手动安装（不想动 profile 依赖）

1. 把本仓库放到 `<profile>/node_modules/dsh-perf-guard`（或建 junction/symlink 指过来）；
2. 在 `<profile>/cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: perf-guard
      name: dsh-perf-guard
```

3. 宿主半随补丁层热重载；浏览器半需要刷新一次界面（Ctrl+R）。

## 卸载 / 回滚

1. 删掉 `<profile>/cordis.patch.yml` 里的 `insert` 行（或 `dsh plugin --profile desktop remove dsh-perf-guard`）；
2. 刷新界面，设置页消失、所有注入的样式与监听随插件卸载移除；
3. 需要清干净时删除 `node_modules/dsh-perf-guard` 与 `localStorage['dsh-perf-guard:prefs']`。

## 工作原理

插件依赖 `@deepseek-ai/dsh-client-ui-chat@0.2.1-rc.4` 暴露的稳定 DOM 契约：

```text
[data-conversation-scroll]      滚动容器
[data-chat-turn]                回合
[data-step-process]             过程组（思考/工具块）
[data-step-process-body]        过程组内容，内部可滚动
[data-variant="think"]         思考行
[data-state="running"|"ok"]   思考行状态
[data-streaming]                正在流式输出
```

全部逻辑都是「观察 + 最小干预」：只点击折叠按钮、只写 `scrollTop`、只注入 CSS，不改 React 树、不碰会话文件。

## 可调参数

都在 `client.js` 顶部附近：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `HEAVY_DOM_NODES` | 12000 | 自动降载的 DOM 节点阈值 |
| `HEAVY_HEAP_BYTES` | 1.1GB | 自动降载的 JS 堆阈值 |
| 脱离 / 恢复距离 | 64px / 24px | 跟随最新输出的判定 |
| 缓动系数 | 0.3 | 每帧逼近剩余距离的比例 |
| 开组时间闸 | 800ms | 流式期间自动展开过程组的最高频率 |

## 开发

```bash
node --check index.js && node --check client.js
node test/client-smoke.mjs     # 假 DOM + 假 slots 的装配冒烟测试
```

## 兼容性

- 目标：DSH 0.2.1-rc.x（`ui-chat` 的 `data-*` 契约）。DSH 大版本升级后请复核上面的选择器。
- 只做渲染层优化，不减少宿主解压会话日志的内存峰值；超大日志仍需删档或离线裁剪。
- `content-visibility` 会让屏幕外内容暂时不可被页内查找命中；可用开关关闭。

## License

MIT
## 自检 / 排查

设置页底部有「自检」分组，直接显示：

- 滚动容器：是否找到 `[data-conversation-scroll]`（多个容器时取最大的可见那个）；
- 跟随状态：当前是「贴底跟随中」还是「已脱离」；
- 思考行 发现/展开：`WeakSet` 去重后的计数；
- 跟随次数。

也可以在 DevTools Console 里执行 `window.__dshPerfGuard` 查看实时状态。

常见原因：

| 现象 | 原因 |
| --- | --- |
| 自检里滚动容器「未找到」 | 当前不在对话页，或 DSH 版本换了容器标记 |
| 跟随状态长期「已脱离」 | 上一次是向上滚动离开的；滚回底部 24px 内自动恢复 |
| 思考行 发现 0 | 思考链块还没渲染（被折叠的过程组里不会出现在 DOM），等 `data-shimmer` 出现后会自动展开 |

## v0.5 新增：动效、跟随修正、错误日志与按状态码重试

### 动效（可关）

| 场景 | 时长 / 曲线 |
| --- | --- |
| 新回合出现 | 260ms `cubic-bezier(.22,1,.36,1)`（easeOutQuint，快进慢停）淡入 + 上移 8px |
| 切换会话 | 240ms `cubic-bezier(.16,1,.3,1)` 整块淡入 + 上移 6px |
| 设置页出现 | 220ms `cubic-bezier(.22,1,.36,1)` 淡入 |
| 开关/按钮微交互 | 120ms `cubic-bezier(.4,0,.2,1)` + `scale(.94)` |

`prefers-reduced-motion: reduce` 时全部关闭；插件热更新后旧 `<style>` 会被覆盖，不会再出现「新 class 没样式」。

### 跟随修正

解除跟随现在必须同时满足：`scrollTop` 真的变小 **且** 刚有用户输入（滚轮/方向键/拖动滚动条），或单次跳动 > 160px。
因此浏览器/React 的滚动锚定（内容变高时的自动补偿）不会再误判成「用户向上滚」而永久脱离跟随。

### 错误日志与重试

- 拦截 `llm/stream`，把 **400 / 401 / 402 / 403 / 429 / 502 / 503** 的状态码、错误码、provider/model、响应片段写进宿主日志；
- 设置页「错误与重试」里可分别开关每个状态码的自动重试，并设置最大重试次数（0–10）；
- 只在本轮**尚未输出任何内容**时重试，避免重复内容；429 优先使用 `Retry-After`，其余指数退避（0.8s 起，封顶 15s）；
- 最近 20 条错误会显示在设置页，配置持久化到 `~/.dsh/perf-guard.retry.json`。
