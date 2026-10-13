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

设置 → 插件 → 自动重命名。全部字段可留空表示「用默认值 / 跟随对话主模型」。

| 字段 | 默认 | 说明 |
|---|---|---|
| 首个对话自动命名 | 开 | 关掉后不再自动改名，建议功能仍可用 |
| Provider / Model | 空 | 留空 = 跟随当前对话的主模型；两者必须成对填写 |
| 建议条数 | 3 | 打开重命名窗口时拉取几条候选（1–5） |
| 输出上限 | 64 | 单次生成的 token 上限 |
| 超时（毫秒） | 60000 | |
| 目标词数 | 5 | 非 CJK 语言的词数目标 |
| 目标中文字数 | 10 | CJK 字符数目标 |

> Provider / Model 只填一个不会生效：会在启动日志里出现一条警告，且用到时明确报错。
> 这是刻意的——半对配置静默失效比报错更难排查。

## 结构

```
lib/config.js    纯逻辑（配置合并、源消息挑选），无依赖，可独立测试
lib/index.js     Host 半边：注册 provider + HTTP 桥（/dsh-auto-rename/suggest）
lib/client.js    Client 半边：顶部按钮 + 重命名 Modal + 设置卡片
cordis.patch.yml bundle patch：插入本插件行、禁用内置 session-title-llm 行
test/            自检（node test/check.mjs / node test/apply-smoke.mjs）
```

Host 与 client 之间只有两条 HTTP 路由，都只接受本机来源（`127.0.0.1` 且
`sec-fetch-site` 非 cross-site）：

- `POST /dsh-auto-rename/suggest` — 拉 N 条候选标题
- `POST /dsh-auto-rename/config` — 回显当前生效配置（排查用）

## 开发

```powershell
npm run check
```

跑三件事：两半的语法检查、纯逻辑自检、以及用假 ctx 的 `apply()` 冒烟测试。

冒烟测试需要一个 `@deepseek-ai/schemastery`。本地开发时从已装的 profile 链一份进来：

```powershell
New-Item -ItemType Junction -Path node_modules\@deepseek-ai\schemastery `
  -Target "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai\schemastery"
```

`test/stubs/` 里有一个 `dsh-session-title-llm` 的替身，用来在 DSH 之外验证调用接线
（它不复制官方实现，只回显收到的参数）。

## 已知边界

- 依赖 `conversation.session.header.actions` 槽位（DSH 0.2.0-rc.2 已声明）。
  宿主升级若改动槽位名，按钮会消失，但自动命名不受影响。
- 自动命名与建议共用同一套 LLM 调用（委托官方 `@deepseek-ai/dsh-session-title-llm`
  的共享实现），因此提示词、超时、归一化行为与内置 provider 完全一致。
- 建议不会往会话日志写 `session/title-llm-request` 事件：那是自动命名的一次性审计
  记录，而建议可以反复重新生成，照写会让日志膨胀。
