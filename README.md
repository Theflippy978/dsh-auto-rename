# dsh-auto-rename

给 DSH 的对话自动重命名：**首个对话自动命名**（Codex 式）+ **重命名窗口里的 AI 建议**。

## 功能

### 1. 首个对话自动命名

会话发出第一条消息、标题仍为空时，自动调用模型生成标题。行为与 DSH 内置的
first-prompt provider 一致，区别只在：

- provider id 是 `dsh-auto-rename`，写进 `session/title` 的 `source.provider`，
  标题来源因此可追溯（日志里能区分「DSH 内置命名的」与「本插件命名的」）。
- 命名模型可配置（默认跟随当前对话的主模型，可指定便宜的小模型）。
- 手动重命名后标题被锁定，不再自动改写（DSH 自身的行为，本插件沿用）。

### 2. 重命名窗口的 AI 建议

对话页顶部（`创造模式` 右侧）有一个「AI 命名」按钮。点开的是一个与 DSH 原生
重命名窗口形态一致的对话框：

- 输入框预填当前标题，可直接改。
- 输入框下方一行小字建议栏：3 条候选 chip + 「重新生成」。点击 chip 填入输入框。
- 回车确认、Esc 关闭、中文输入法组字期间回车不误提交——与原生窗口同款行为。

提交走官方通道（`sessions.using(id, {source:"workspaceOperation"}, …rename(title))`），
与侧栏双击标题改名是同一条路。

## 安装

```powershell
dsh plugin --profile desktop add <本仓库路径>
```

本包声明了 `dsh.bundle.patch`，所以安装时会自动：

1. 把 `dsh-auto-rename` 插入 profile 的 bundle 栈。
2. **禁用 dsh-base 内置的 `session-title-llm` 行**——`SessionTitleService.register()`
   全局只接受一个 provider，内置行先注册就会让本插件的注册抛错。

装完重启 DSH。

## 设置

设置 → 插件 → 点开 `dsh-auto-rename` 详情页的配置区。表单用宿主官方的
`SettingsForm`，所以样式、暂存草稿与「保存」按钮跟其它插件的设置页一致：
改完要点保存才写盘，留空表示「用默认值 / 跟随对话主模型」。

| 字段 | 默认 | 说明 |
|---|---|---|
| 首个对话自动命名 | 开 | 关掉后不再自动改名，建议功能仍可用 |
| 命名模型 | 跟随主模型 | **下拉列出宿主已认证的模型**；选中即同时写入 Provider 与 Model |
| 建议条数 | 3 | 打开重命名窗口时拉取几条候选（1–5） |
| 输出上限（token） | 64 | 单次生成的 token 上限 |
| 超时（毫秒） | 60000 | |
| 标题宽度（中文字数） | 12 | **长度只有这一个旋钮**，超出硬截断 |

标题长度按**显示宽度**算，中英文共用同一个预算：1 个中日韩字 = 2 个半角单位，
其余字符（含空格）= 1 个单位。所以「12」等价于中文最多 12 字、英文最多 **24 个
字符（含空格）**，约 3–4 词（实测 `Refactor plugin settings` 正好 24 单位）。

英文**不单独设词数上限** —— 单词字符数不一致，按词数约束没有意义。官方共享实现
要求一个 `targetWords`（只进提示词，不做截断），这里从宽度预算折算得到
（24 单位 ÷ 约 6 单位/词 = 4），让模型的目标长度尽量贴着硬截断的预算，减少
「先写长再被截」。因此调大「标题宽度」会同时放宽中英文，不需要动第二个数。

截断遇到拉丁词中间会回退到上一个空格，不留 `sessio` 这种残词；整段没有空格可退
（如 `provider/model` 路由、URL）时宁可不截。宿主另有一层 `maxTitleBytes`
（官方配 80 字节 ≈ 26 个汉字）兜住极端长度，所以宽度旋钮的实际上限在它之下。

「命名模型」的数据源是宿主的 `remote.session.modelCatalog()`：它逐个 provider
试列模型，列不出来的（没配密钥、已停用）不进目录，所以下拉里出现的都是当前
真能用的模型，不必再手填。若宿主没组合 remote 或目录调用失败，这一行自动退回
手填 Provider / Model 两个字段——配置能力不会因此消失，其余字段不受影响。

> 手填 Provider / Model 时只填一个不会生效：启动日志里会有一条警告，且用到时
> 明确报错。这是刻意的——半对配置静默失效比报错更难排查。

### 命名读的是什么

两种场景都**只看人类发的消息**，完全不看助手回复：

- **首个对话自动命名**：只取第一条人类消息。与 Codex 的 first-prompt 语义一致，
  也最省 token。
- **重命名窗口的建议**：取最近 3 条人类消息，因此能概括进行中的话题而不只是开场白。

两边都按 `maxInputBytes`（默认 4096）逐条裁剪后再交给模型——官方共享实现在输入
超限时是直接抛错的，不裁就会表现为「建议获取失败」。

## 结构

```
lib/config.js    纯逻辑（配置合并、源消息挑选、标题截断），无依赖，可独立测试
lib/index.js     Host 半边：注册 provider + HTTP 桥（/dsh-auto-rename/suggest）
lib/client.js    Client 半边：顶部按钮 + 重命名 Modal + 设置卡片（官方 SettingsForm）
                 模型下拉的数据源是宿主 remote.session.modelCatalog()
cordis.patch.yml bundle patch：插入本插件行、禁用内置 session-title-llm 行
test/            自检（check / apply-smoke / client-smoke / locale-audit / patch-check）
```

Host 与 client 之间只有两条 HTTP 路由，都只接受本机来源（`127.0.0.1` 且
`sec-fetch-site` 非 cross-site）：

- `POST /dsh-auto-rename/suggest` — 拉 N 条候选标题
- `POST /dsh-auto-rename/config` — 回显当前生效配置（排查用）

## 开发

```powershell
npm run check
```

跑五件事：两半的语法检查、纯逻辑自检（含标题截断与字节预算）、host `apply()` 冒烟、
client `apply()` 冒烟（假 ctx 真渲染顶部入口与设置卡片，含模型目录的三种降级）、
中英字典对齐审计，以及 `cordis.patch.yml` 的组合结果。

冒烟测试需要一个 `@deepseek-ai/schemastery`。本地开发时从已装的 profile 链一份进来：

```powershell
New-Item -ItemType Junction -Path node_modules\@deepseek-ai\schemastery `
  -Target "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai\schemastery"
```

`test/stubs/` 里有一个 `dsh-session-title-llm` 的替身，用来在 DSH 之外验证调用接线
（它不复制官方实现，只回显收到的参数）。

## 已知边界

- 顶部按钮依赖 `conversation.session.header.actions`，设置卡片依赖
  `plugins.bundle.config`（均为 DSH 0.2.0-rc.2 已声明的槽位）。宿主升级若改动
  槽位名，对应界面会静默消失——槽位没被声明时 `slots.inject` 的回调根本不触发，
  不会报错。设置卡片缺席时顶部按钮仍在，反之亦然。
- 自动命名与建议共用同一套 LLM 调用（委托官方 `@deepseek-ai/dsh-session-title-llm`
  的共享实现），因此提示词、超时、归一化行为与内置 provider 完全一致。
  长度上限是本插件额外加的：官方把 `normalizeSessionTitle` 的截断参数传成
  `Number.MAX_SAFE_INTEGER`，等于完全不截，所以「最多几个字」由我们兜底。
- 建议不会往会话日志写 `session/title-llm-request` 事件：那是自动命名的一次性审计
  记录，而建议可以反复重新生成，照写会让日志膨胀。
