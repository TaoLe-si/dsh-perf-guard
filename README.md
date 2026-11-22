# 性能守卫 · dsh-perf-guard

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的长会话插件。减少长对话在滚动和渲染时的开销，并给临时模型请求失败提供有上限的重试。

Perf Guard for DSH reduces transcript rendering work, respects native scrolling in newer Chat versions, and adds bounded retries and local diagnostics. It does not delete sessions or stop agents.

## 安装

在 DSH 的插件管理界面添加下面的 GitHub 来源。使用 CLI 时，将 `desktop` 换成实际 profile 名；Web 通常为 `web`。

```sh
dsh plugin --profile desktop add github:TaoLe-si/dsh-perf-guard#v1.9.4
```

也可从 [GitHub Releases](https://github.com/TaoLe-si/dsh-perf-guard/releases) 获取固定版本的安装包。不需要 npm 账号或额外构建步骤。不要在同一个 profile 中同时使用 Bundle 安装和手工插入插件行。

安装或升级后，打开 **设置 → 性能守卫**。更新已加载的宿主代码时，先等正在运行的工作结束，再重启 DSH；浏览器端刷新页面。如果面板仍显示旧版本，检查当前 profile 的插件来源。

## 能做什么

| 场景 | 行为 |
| --- | --- |
| 流式输出时查看历史 | 新版 Chat 由 DSH 管理滚动和「回到底部」，插件不会替你点按钮。旧版在贴底时平滑跟随，小幅上滚即暂停，实际回底后再继续。 |
| 查看运行中的过程 | 只在所在对话贴底时自动展开运行中的思考行和可见过程组，避免把不可见的标题带入视野或抢走输入焦点。 |
| 长会话卡顿 | 跳过部分离屏过程的渲染、限制过长工具输出的展示高度、滚动时暂缓动画与滤镜。整回合降载可能影响布局测量。 |
| 临时模型请求失败 | 默认对 HTTP `429`、`502`、`503` 以及部分传输中断、超时或空响应重试。默认让 DSH 原生重试先决，不把拒答、鉴权失败或取消视为网络故障。 |
| 子代理路由被拒绝 | 保留失败结果和权限判断，补充可操作的恢复提示。不自动重试或替换显式指定的模型。 |
| 排查本机内存 | 设置页显示渲染和宿主的采样数据；宿主统计区分仍挂载的空闲 Agent 与运行中的 Agent，不打开冷历史。 |

### 冷会话缓存（可选）

在 DSH `0.2.2-rc.5` 中，历史查询默认最多保留 5 份可复用的冷会话准备缓存。要减少这部分驻留内存，可在当前 profile 的 `session-query-sqlite` 条目中**保留其他配置，只增设** `preparedSessionCacheSize: 1`，然后重启。参考 [Web 默认配置示例](session-cache.patch.yml)；不要用它覆盖自定义索引路径、搜索开关或其他配置。插件常规安装不会改写该条目。

正在使用的历史读引用不会被淘汰。再次打开已淘汰的历史时，DSH 会从持久化记录重新准备，可能稍慢。这不会卸载已经挂载的空闲 Agent，也不会清理后台任务、删除会话或者改动输出文件。限额是缓存份数，不是 RSS 或堆用量保证。

### 重试和输出

- 设置页可调整重试次数（`0`–`8`，默认 `2`）和临时错误开关；高堆压力时插件不再追加重试。重试会再次请求当前模型，可能增加等待时间与用量。部分网关错误或传输中断发生在流式输出中时，已显示的半截内容可能保留。
- 长度截断通常无法靠重试解决。反复截断时检查模型的输出上限；不想在已输出后重试，可以关闭「截断 / 传输中断重试」。
- **输出清理**只处理正文中带 `<thinking>`、`<thought>` 或 `<reasoning>` 标签的内容。默认保留为可折叠的思考块；也可丢弃这部分新输出，或关闭处理以原样保留。它不重写已有历史。
- 子代理如果可以用默认模型，省略 `provider`、`model` 和 `reasoning_effort`，不要传空字符串。需要显式选择时，用 `list_subagent_models`（从 `{}` 开始）查当前会话允许的路由，再选择精确的 `provider` / `model`。如果列表为空，不要重复枚举或原参数；直接完成当前任务，或告知当前会话没有可用子代理路由。

## 隐私与兼容性

- 不采集遥测，不向第三方上传会话。重试仍通过 DSH 调用已配置的模型服务。宿主日志和最近错误摘要可能含模型名称或上游错误片段，分享排障信息前先检查内容。
- 诊断和设置接口仅接受 DSH 认证的 owner，并要求 `x-dsh-plugin: perf-guard` 请求头。请求头不是登录凭证；缺少原生认证接口的宿主不会开放这些端点。静态图片不需要认证。
- 浏览器偏好存于当前站点的 `localStorage`；重试及输出清理偏好保存在 DSH 数据目录的 `perf-guard.retry.json`。禁用或移除 Bundle 不会删除会话，也不会复原自行设置的冷缓存参数。
- 版本门槛为 DSH `0.2.1-rc.4`，已核对 Windows Desktop 的 `0.2.2-rc.5`。滚动和宿主能力按运行时探测；旧宿主可用的设置与诊断功能取决于其认证接口。新版原生 Chat 在距离底部约 25 像素内仍可能保持跟随，这是 DSH 的判定。

<details>
<summary>诊断接口与本地开发</summary>

| 路径 | 用途 |
| --- | --- |
| `GET /api/perf-guard/health` | 查看已加载的插件版本 |
| `GET /api/perf-guard/stats` | 查看进程内存、驻留 Agent 数、会话日志大小和近期错误摘要 |
| `GET/POST /api/perf-guard/retry` | 查看或更新插件的重试和输出清理偏好 |

```sh
npm run check
npm test
npm pack --dry-run
```

</details>

## 反馈与许可

通过 [GitHub Issues](https://github.com/TaoLe-si/dsh-perf-guard/issues) 提交问题。请注明 DSH 与插件版本、Desktop 或 Web、触发步骤，以及去除敏感信息后的必要日志。[更新记录](CHANGELOG.md) · [MIT License](LICENSE)
