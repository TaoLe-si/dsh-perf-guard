# Changelog

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