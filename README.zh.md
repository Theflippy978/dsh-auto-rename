<div align="center">

<img src="icon.svg" width="112" height="112" alt="dsh-auto-rename 图标" />

# dsh-auto-rename

**DeepSeek Harness 的对话自动命名。**
首条消息自动定名，重命名弹窗流式给出 AI 建议。

[![版本](https://img.shields.io/badge/版本-0.1.0-4176e6)](package.json)
[![许可](https://img.shields.io/badge/许可-MIT-4176e6)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-0.2.0--rc.2-6b7280)](#已知边界)
[![node](https://img.shields.io/badge/node-%E2%89%A522.19-6b7280)](package.json)

[English](README.md) · 中文

</div>

---

## 功能

**首条消息自动定名。** 会话发出第一条消息、标题仍为空时生成一次标题，且只看这一条消息。
之后手动改名会把标题钉住，不会再被自动改写。

**改名时给出建议。** 对话页顶部有「AI 命名」按钮，弹出的对话框与 DSH 原生重命名窗口长得一样、
手感一样，只多三样东西：

| | |
|---|---|
| 流式候选 | 建议逐条到达（NDJSON），每条配 500ms 从左到右的扫描线揭示 |
| 一键填入 | 点 chip 即填入输入框；点「重新生成」换一批 |
| 原生手感 | 回车确认、Esc 关闭、输入法组字期间回车不误提交 |

**模型由你挑。** 默认跟随当前对话的主模型，也可以钉一个更便宜的小模型。下拉的数据源是宿主的
`remote.session.modelCatalog()`：它逐个 provider 试列，列不出来的不进目录 —— 所以每一项都是
宿主**已认证**且真能调用的模型。

**留得下审计线索。** provider id `dsh-auto-rename` 会写进每条 `session/title` 事件的
`source.provider`，所以随时能分辨哪些标题是这个插件生成的。

<details>
<summary><b>为什么不扩展原生重命名窗口，而要自建</b></summary>

原生重命名窗口是宿主内部组件，没有任何扩展点：`RenameForm` 不声明可注入槽位，它需要的
`requestSessionRename` 只作为 prop 传给侧栏菜单项，整个 bundle 也没有 `ctx.provide` 它。
所以插件既塞不进建议条，也无法程序化唤起它。只能自建对话框，再逐条抄原生窗口的 CSS 规则，
让两者看起来完全一样。

</details>

## 安装

```sh
dsh plugin add dsh-auto-rename
```

或从仓库安装：

```powershell
dsh plugin --profile desktop add <本仓库路径>
```

本包声明了 `dsh.bundle.patch`，安装时除了把 `dsh-auto-rename` 插入 profile 的 bundle 栈，
还会**禁用 dsh-base 内置的 `session-title-llm` 行**。第二步是必须的：
`SessionTitleService.register()` 全局只接受一个 provider，内置行先注册就会让本插件的注册抛错。

装完重启 DSH。client 半边会热更新，host 半边必须重启才生效。

## 设置

打开「AI 命名」弹窗，点标题行里那个齿轮图标（在关闭键左边），面板就在同一个弹窗内展开。
改动先进草稿，点「保存」才写盘；留空表示用默认值。

| 字段 | 默认 | 说明 |
|---|---|---|
| 首个对话自动命名 | 开 | 关掉后建议功能仍可用 |
| 命名模型 | 跟随主模型 | 只列出宿主已认证、当前能列出的模型 |
| 建议条数 | 3 | 每次打开弹窗拉取几条候选（1–5） |
| 输出上限（token） | 64 | 单次生成的 token 上限 |
| 超时（毫秒） | 60000 | 单个标题的最长等待 |
| 标题宽度（中文字数） | 12 | **唯一的长度旋钮**，超出即截断 |

若宿主没有组合 remote、或列模型失败，模型那一行会退回手填 **Provider** / **Model** 两个字段。
两者必须成对填写：只填一个会在启动日志里留一条警告，用到时明确报错，而不是静默不生效。

## 工作方式

**只读你打的字。** 两条路径都不看助手回复：自动命名取第一条人类消息，建议取最近三条，
因此建议概括的是进行中的话题而不是开场白。每条消息在交给模型前按 `maxInputBytes`
（默认 4096）裁剪 —— 官方共享实现在输入超限时直接抛错。

**长度按显示宽度算，不按字符数。** 1 个中日韩字算 2 个半角单位，其余字符（含空格）算 1 个。
预算 = 标题宽度 × 2，所以默认的 `12` 等于中文 12 字、或英文含空格 24 个字符，约 3–4 词。
一个旋钮同时管两种文字；英文不单独设词数上限，因为单词长度差异太大，按词数约束没有意义。

官方共享实现仍要求一个 `targetWords`（只进提示词，不做截断），所以它由同一个预算按
约 6 单位/词折算 —— `12` 得到 `4`。这让模型的目标长度贴着硬截断走，而不是先写长再被裁。

**截断不会切坏单词。** 切进拉丁词中间会回退到上一个空格，不会出现 `sessio` 这种残词；
整段没有空格可退时（`provider/model` 路由、URL）宁可不截 —— 略超宽比残词好。

<details>
<summary><b>为什么必须由本插件来截断</b></summary>

官方调用方给 `normalizeSessionTitle` 的截断参数传的是 `Number.MAX_SAFE_INTEGER`，
等于完全不截。宿主确实有一层 `maxTitleBytes` 上限（80 字节 ≈ 26 个汉字），但它太宽松，
管不住"太长"。所以"别太长"只能由本插件守住，宽度旋钮的实际上限也就落在宿主字节限制之下。

</details>

## 项目结构

```
lib/config.js    纯逻辑：配置合并、源消息挑选、标题截断。零 import，可独立测试。
lib/index.js     Host 半边 —— 注册 title provider 与 HTTP 桥。
lib/client.js    Client 半边 —— 顶部按钮、重命名弹窗、弹窗内设置面板。
cordis.patch.yml bundle patch：插入本插件、禁用内置 session-title-llm。
locale/          插件管理器要用的展示元数据（标题、描述）。
test/            自检：逻辑、host apply、client 渲染、字典审计、patch。
```

两半边通过三条 HTTP 路由通信，都只接受回环来源
（`127.0.0.1`、`::1`、`::ffff:127.0.0.1`），且拒绝 `sec-fetch-site: cross-site`：

| 路由 | 用途 |
|---|---|
| `POST /dsh-auto-rename/suggest` | 以 NDJSON 流式返回 N 条候选标题 |
| `POST /dsh-auto-rename/config` | 回显当前生效配置，排查用 |
| `POST /dsh-auto-rename/settings` | 经宿主 `settings` 服务写配置，按白名单过滤 |

写路由在宿主 `settings` 服务缺席时返回 **503**，而不是谎报保存成功。

## 开发

```powershell
npm run check
```

六道门禁，都快、都不联网：

1. host 与 config 模块语法检查，外加 client bundle 的解析检查。
2. 纯逻辑自检 —— 配置合并、消息挑选、宽度预算、字节预算。
3. host `apply()` 冒烟（假上下文）：元数据、降级路径、provider 形状、路由守卫，
   以及 Config schema 的精确字段清单。
4. client `apply()` 冒烟：真渲染顶部入口与设置面板，覆盖模型目录的三种降级。
   假上下文复刻了宿主那个受限 facade，包括**读 `ctx.inject` 会抛错**这一条。
5. 字典审计：代码里用到的每个 key 在 zh、en 两份里都存在。
6. patch 检查：`cordis.patch.yml` 禁用了内置行、插入了本插件行，且没碰到别的行。

冒烟测试需要 `@deepseek-ai/schemastery`。本地从已装的 profile 链一份进来：

```powershell
New-Item -ItemType Junction -Path node_modules\@deepseek-ai\schemastery `
  -Target "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai\schemastery"
```

`test/stubs/` 里有一个 `dsh-session-title-llm` 替身，只回显收到的参数，
用来在 DSH 之外验证调用接线，而不必复刻官方 provider。

## 已知边界

- **槽位改名会静默失效。** 顶部按钮依赖 `conversation.session.header.actions`
  （DSH 0.2.0-rc.2 声明）。槽位未被声明时 `slots.inject` 的回调根本不触发，也不报错 ——
  所以宿主升级若改了槽位名，按钮会无声消失。顶部那枚版本徽章记录的是最后一次验证过的宿主版本。
- **设置刻意不放在宿主设置页。** 可用的两个槽位都实测过（`plugins.bundle.config` 与
  `plugins.item`）：在插桩替身里注册成功，真实界面什么都不渲染，且不报错。
  所以面板画在弹窗里、读写走 HTTP 桥。
- **提示词就是官方那套。** 自动命名与建议共用一条 LLM 调用路径，委托
  `@deepseek-ai/dsh-session-title-llm` 的共享实现，因此提示词、超时、归一化行为与内置 provider
  完全一致。只有长度上限是本插件额外加的。
- **建议不写日志。** 不会往会话日志写 `session/title-llm-request` 事件：那是自动命名的一次性
  审计记录，而建议可以无限次重新生成，照写会让日志膨胀。

## 许可

[MIT](LICENSE)
