# dsh-antigravity

DeepSeek Harness (DSH) 的 **Google Antigravity** 模型提供商插件：原生 `LlmAdapter` 实现 + 多账号管理 UI + 自有凭据存储。

凭据只落在 DSH 自己的 `ctx.credentials` 记录、插件自有的 `~/.dsh/antigravity-accounts.json`（0600）与 `~/.dsh/antigravity-auth.json`（0600）中，不读写任何第三方应用的数据库（见「凭据存放位置」）。

---

## 它能做什么

| 能力 | 实现 |
| --- | --- |
| 原生提供商路由 | 提供商目录挂在插件自有的 `llm-antigravity` 命名空间；`google-antigravity` 只由原生适配器提供 |
| 多账号 + 配额故障转移 | 可登录多个 Google 账号；按 `accountStrategy` 轮询或优先默认账号；某账号 429 配额耗尽时**当次调用**直接换号，并按响应体里的重置时间把它停用到那一刻 |
| 设置页账号管理 | 通过 `settings.models.provider-card` 插槽在「设置 → 模型 → Google Antigravity」卡片内列出全部账号：健康、项目、令牌有效期、冷却倒计时，以及添加 / 设为默认 / 逐个退出 |
| 自有凭据存储 | 账号清单写在 `~/.dsh/antigravity-accounts.json`；`ctx.credentials`（`dsh-antigravity/google-antigravity` 记录）与 `~/.dsh/antigravity-auth.json` 始终镜像**默认账号**，旧安装无需迁移 |
| 可选 OpenAI 兼容代理 | `proxy.enabled` 开启（默认关闭）时，为不能加载 DSH 插件的客户端提供 OpenAI 兼容端点 |
| 思考与工具调用解析 | 只以 `part.thought === true` 判定思考过程；块状态机解析流式响应；工具调用优先于 `max-tokens` |
| 工具 schema 方言投影 | 构造请求前投影工具 schema：`const` → 单值 `enum`，剥掉端点不认的引用/文档关键字；原生适配器与 OpenAI 兼容代理共用同一投影 |

---

## 在 DSH 中使用

插件随 profile bundle 加载，无需额外配置即可在模型选择器中出现 `google-antigravity`。

### 账户闭环：没有账户 → 添加 → 登录 → 再加一个 → 移除

**默认状态是「没有这一行」。** 插件注册的目录条目 `settingsPath: ['account']`，而 `account` 没有 schema 默认值，于是 `configured` 为假 —— 设置页不会出现 Google Antigravity 行，只在 **添加提供方** 下拉里留一个条目。这满足 DSH 的两条互斥规则：`configured === false` 才进下拉，`configured === true` 才成行（`deepseek-official` 同理，只是它恒为真）。

安装一个账户 = 让那个标记出现。写标记的人就是插件自己：

| 步骤 | 你做什么 | 插件做什么 |
| --- | --- | --- |
| **添加 + 登录** | **设置 → 模型 → 添加提供方 → Google Antigravity**，在卡片里点 **登录 Google 账号** | 起回环监听 `http://127.0.0.1:51121/oauth-callback` 并打开授权页；授权落地后把这个账号登记进注册表、设为默认账号，再把 `llm-antigravity.account` 写进 `settings.yaml` —— 行随之出现 |
| **再加一个** | 卡片底部的 **添加账号**，用另一个 Google 账号走同一套授权 | 新账号追加进注册表并成为默认账号；已经登录的账号一个都不动 |
| **换默认** | 某个账号行内点 **设为默认** | 改写 `activeId`；镜像文件与 `ctx.credentials` 记录改跟这个账号 |
| **退出一个** | 某个账号行内点 **退出登录** | 只移除该账号；还有别的账号时行与标记都保留，默认账号顺延到剩下的账号 |
| **全部移除** | 行右上角点 **移除**，或对最后一个账号点 **退出登录** | 撤掉 `account` 标记，行随之消失，回到下拉里；标记消失**满 1 秒确认**后才清空注册表与全部镜像（设置重载的瞬时闪烁不算移除），且清空前会留一代 `.bak` 备份 |
| **取消** | 等待授权时点 **取消**（或关掉授权页直到 10 分钟超时） | 结束本次尝试，卡片说明原因 |

卡片在两种位置都会渲染：下拉里的草稿卡（此时是「添加」）和已经成行的行卡（此时是「管理」）。状态与操作完全一致。标记落地、行出现后**草稿卡立即退场**：原生页面不会替你合上那张草稿卡（写 settings 的是插件自己，没有任何编辑器关闭动作会来清理它），而 `account` 已经让这个条目从下拉里消失 —— 留在原地的卡片会被看成挂在下拉回退显示的那个提供方上。此后状态与操作由行卡独占：

| 卡片状态 | 显示 | 可用的操作 |
| --- | --- | --- |
| 没有账户 | 红点 + 未登录 | **登录 Google 账号** |
| 等待授权 | 黄点 + 等待浏览器完成授权… | **重新打开授权页** / **取消** |
| 凭据过期 | 红点 + 登录已过期，请重新登录 | **登录 Google 账号** |
| 已登录 | 绿点 + 已登录（两个以上账号时附数量与当前策略），下方每个账号一行 | 每行 **设为默认** / **退出登录**；底部 **添加账号** |

每个账号行上的点表示**它自己**的健康度，而不是整个提供商的：

| 行状态 | 显示 | 含义 |
| --- | --- | --- |
| 可用 | 绿点 + 邮箱 + 项目 + 令牌有效期 | 下一次调用可能落到它头上 |
| 默认 | 邮箱后的 **默认** 胶囊 | 镜像文件与 `ctx.credentials` 记录跟它；`active-first` 下先用它 |
| 配额冷却 | 黄点 + 配额冷却中，约 N 分钟后恢复 | 上一次 429 说要等这么久；冷却期内的调用跳过它 |
| 令牌过期 | 红点 + 登录已过期，请重新登录 | 刷新也救不回来（refresh token 失效），需要重新登录这个账号 |

`account` 是**目录标记，不是凭据**：它只记一个可读的标签（邮箱或项目 ID），真正的授权在 `ctx.credentials` 里。两条规则保证两者一致：

- 读卡片时若发现账户存在但标记缺失（例如凭据是 CLI 装的，或来自更早的版本），插件会把标记补上 —— 账户存在就该有行；
- 标记从「有」变「无」时（原生 **移除**、或你手改 `settings.yaml` 删掉它），插件同时删掉凭据。只有这个**状态迁移**会删凭据：CLI 装的凭据从来没有标记，无关的设置改动也不会碰它。

> 原生编辑器的「应用」按钮对非 `llm-deepseek` / `llm-pi-ai` 的命名空间是永久禁用的（DSH 只给这两个布局做了表单），所以「添加」这一步必须由插件自己写 settings —— 光靠页面上的保存按钮，条目会永远卡在下拉里。

### 多账号是怎么工作的

账号清单是插件自有的一份注册表 `~/.dsh/antigravity-accounts.json`（0600）：每个账号一条，记 id（邮箱的哈希）、邮箱、项目、加入时间、最后使用时间，以及被配额停用的截止时刻；凭据本身也在里面。

清单不能放在 `ctx.credentials` 里：那个 seam 按 key 存一条记录、**枚举不出列表**（没有 list 操作），它能可靠表达的只有「默认账号是哪一条」。于是分工是：

| 存储 | 角色 |
| --- | --- |
| `~/.dsh/antigravity-accounts.json` | 账号**清单**（唯一事实源）：谁在里面、谁是默认、谁在冷却 |
| `ctx.credentials` 的 `dsh-antigravity/google-antigravity` | 始终镜像**默认账号**；登录 flow 仍然在这里提交记录（DSH 会校验这一点） |
| `~/.dsh/antigravity-auth.json` | 同样镜像默认账号，供独立 CLI / 在 DSH 之外启动的代理使用 |

**同邮箱再次登录是刷新那一条，不是新增**；不同邮箱才追加。升级路径不需要你动手：注册表为空时，插件会把 seam 记录或旧镜像里的那一个凭据自动登记为首个账号 —— 旧版本装好的账号第一次读状态时就已经在列表里了。

旧账号可能**没有邮箱**（早期版本存下来的凭据里没有这一项）。这种条目只会显示成项目名（例如 `aicode-consumers`），而且再用**同一个** Google 账号登录会多出一条新条目 —— 因为插件当时无从知道它们其实是同一个账号。因此插件会在**该账号第一次刷新令牌时**问 Google「这是谁」，把邮箱补上，并把因此产生的重复条目合并掉（保留最先加入的那条，取过期更晚的凭据、更晚的冷却与默认账号身份）。想让某个账号立刻补上身份，用 `refresh --account <id>` 显式刷一次即可。

调用时选哪个账号由 `accountStrategy` 决定，两个策略都带同一种故障转移：

- `round-robin`（默认）：连续调用在可用账号之间轮转，避免把一个订阅的配额先烧完；
- `active-first`：先把默认账号用到底，不可用了才动别人。

故障转移发生在**一次调用内部**：某个账号被 429（配额）或 401/403（凭据）拒绝时，适配器把失败报给账号池，池给它打上冷却截止时间，同一次调用立刻换下一个账号重发；全部账号都不行时抛出的仍是**最后那个真实错误**，而不是笼统的「没有凭据」。传输类失败（5xx / 网络）不换号 —— 换谁都一样，只会把一次坏请求乘上账号数。冷却时长优先取响应体里的 `Resets in 1h31m29s`，读不出来时保守停 10 分钟（上限 24 小时）。

也可以在终端操作账号（插件装在 profile 内，所以可执行文件也在 profile 内，不在全局 PATH）。CLI 与 DSH 用**同一份注册表和同一个账号池**，所以终端里加的账号，运行中的 DSH 下一次调用就能用上。CLI 只碰凭据、不写 settings，所以它登录后行不会自己出现 —— 下次打开那张卡片时会补齐标记：

```bash
D=~/.dsh/profiles/web/node_modules/.bin/dsh-antigravity
$D login                        # 浏览器 OAuth 登录，并登记为默认账号
$D accounts                     # 列出全部账号（默认 / 冷却 / 过期一目了然）
$D accounts --active <id>       # 换默认账号
$D accounts --remove <id>       # 移除某个账号
$D status                       # 查看认证状态、账号列表与模型列表
$D logout                       # 清除全部账号
$D logout --account <id>        # 只清除某个账号
$D refresh                      # 强制刷新默认账号的 access token
$D refresh --account <id>       # 只刷某个账号，顺带补齐它的邮箱身份
```

无头 / ACP 等没有浏览器界面的面走 `ctx.authorization` 注册的同一条 flow（key `dsh-antigravity/google-antigravity`，方法「使用 Google 账号登录」），它同样会写标记。

### 选为默认模型

```yaml
# ~/.dsh/settings.yaml
agent-default-model:
  provider: google-antigravity
  model: gemini-3.8-flash
  reasoningEffort: high
```

### 可选：OpenAI 兼容代理

给不能加载 DSH 插件的客户端（脚本、其他编辑器）使用：

```yaml
# ~/.dsh/settings.yaml
llm-antigravity:
  proxy:
    enabled: true
    host: 127.0.0.1
    port: 8045
```

或独立启动：

```bash
dsh-antigravity proxy --port 8045
```

端点：`GET /v1/models`、`GET /v1/auth/status`、`POST /v1/chat/completions`。

---

## 用量统计

插件自带一套**只统计自己这条路由**的用量账本：每次 `google-antigravity` 调用结束后，
适配器把词元数、首字延迟（TTFT）、总时长、终止原因交给采集器，落进
`~/.dsh/antigravity-usage.db`（`node:sqlite`，0600，不引入任何依赖）。

**只有装了账户的人才会看到这一页。** `settings.section` 没有逐项的可见性开关，所以门禁就是
注册本身：浏览器半启动时探测一次宿主（设置标记或已存凭据），只有拿到「已登录」才把
**设置 → 用量统计** 注册进设置导航；没账户的安装看不到它，而不是看到一个永远空着的页面。

打开这一页就会**自动统计**（见下），你不需要先按任何按钮：

| 区块 | 内容 |
| --- | --- |
| 累计条 | **不受时间范围影响**的全时间总量：请求数、总词元、等价成本、覆盖的时间跨度 |
| 时间范围 | `1h` / `24h` / `7d` / `30d` / `90d` / 全部（默认 24h） |
| 概览卡 | 当前范围内的：请求数、总词元、缓存命中率与节省、等价成本、输入/输出/缓存词元、平均 TTFT、平均时长、输出速率 |
| 请求趋势 | 按桶的请求数折线 + 失败数折线（1h→5 分钟、24h→小时、更长→天） |
| 按模型 | 请求、四类词元、缓存率、TTFT、等价成本 |
| 按项目 | 按会话工作目录聚合，展示末两级路径作为短标签 |
| 按账号 | 按服务这次调用的 Google 账号（邮箱）聚合 —— 多账号下「哪个账号烧了多少配额」就是这一行；账号功能上线前写入的历史（以及全部日志回溯行）归入 `(unknown)` |
| 最近请求 | 最近 12 条：时间、模型、词元、时长、等价成本、成功/失败/中止 |

「累计条」独立于范围选择器：**「一共用了多少」和「这个窗口用了多少」是两个问题**，
不该逼着人把范围切到最宽再从卡片里读回来。

同理，**「窗口内为空」不等于「从未记录」**：默认 24h 窗口里没有调用、但历史里有几千条时，
面板会显示累计数量并提示切到「全部」，而不是甩一句「还没有记录到调用」。

统计口径（写进代码注释并由单元测试约束）：

- 词元四桶**互不重叠**（`inputTokens` 不含缓存命中），`totalTokens` 恒等于四者之和；
- `aborted`（用户主动中断）**不算失败**，只有 `error` 计入错误率；
- 首字延迟取「请求开始 → 第一个内容增量」，`usage` / `finish` 这类记账块不启动计时；
- 缓存命中率 = `cacheRead / (input + cacheRead)`；
- 成本是**按内置单价的 API 等价估算**，不是账单（Antigravity 是订阅制）。内置单价来自
  Oh My Pi 的内嵌定价表，并用本机真实账单反推的隐含单价交叉验证过；
- 日桶按**本地时区**对齐。

数据只落在本机；用量面板的 HTTP 路由与登录路由共用同一套回环校验（Host/Origin +
浏览器会话），不联网、不外发。

### 打开即统计历史

实时采集只看得到**装上插件之后**的调用，所以刚装好时历史上是一片空白。打开面板本身
就是「把历史算出来」的触发：**每次打开都自动扫一次** `~/.dsh/sessions/`——DSH 每个
`assistant/message` 事件都带着 provider 上报的 `usage`，一次扫描就能把过去翻出来。
面板上的 **重新统计** 按钮用于不离开页面时强制再扫一次。

之所以能每次打开都扫，是因为扫描按**文件修订**做增量：每个会话文件的
`(mtime, size)` 记在 `usage_files` 表里，没变动的文件只做一次 `stat` 就跳过，根本不解压。
实测（本机，101 个会话文件 / 72,597 个事件）：

| 扫描 | 耗时 | 解压文件 | 解析事件 |
| --- | --- | --- | --- |
| 首次 | 2067 ms | 101 | 72,597 |
| 再次 | **4 ms** | 0（全部跳过） | 0 |

匹配到 176 条历史 Antigravity 调用。写入本身也是幂等的（键为 `会话:事件序号`），
重复扫描不会重复计数。

两点口径要说明，代码里也写死了：

- 会话日志**不保存**首字延迟与总耗时，统计出的历史行这两列是空的（`—`）；
- 日志也不保存终止原因，历史行一律计为成功。

日志是多帧 zstd（`session.v3.jsonl.zstd`），Node 自带的 `zstdDecompress` 只读第一帧，
所以统计会调用系统的 `zstd` 命令；它不在 PATH 时会明确报错而不是猜。
单文件解压超过 128 MB 会被跳过并记录在返回的 `failed` 里，不影响其余文件。

---

## 设置项（`~/.dsh/settings.yaml` → `llm-antigravity`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `account` | 未设置 | **账户标记**：存在即表示已有账号安装在此，设置页才会出现该行。值是默认账号的标签（多个账号时形如 `me@gmail.com（共 3 个账号）`）。由插件在登录时写入、全部账号移除时删除；手工删掉它等于移除**全部**账号 |
| `accountStrategy` | `round-robin` | 账号选择策略：`round-robin` 轮转 / `active-first` 优先默认账号。两者都会在 429/401 时换号，也都会把配额耗尽的账号冷却到重置时刻 |
| `models` | 内置 11 个模型 | 可覆盖/增删；每项含 `id`、`wireId`、`name`、`contextWindow`、`maxTokens`、`reasoning`、`inputModalities` |
| `endpoint` | `https://daily-cloudcode-pa.googleapis.com` | 首选端点，失败后回退到内置端点列表 |
| `projectId` | 登录时自动发现 | Antigravity 项目 ID，缺省 `aicode-consumers` |
| `clientId` / `clientSecret` | 内置 Antigravity 客户端 | 可用环境变量覆盖，见下 |
| `redirectUri` | `http://127.0.0.1:51121/oauth-callback` | 必须与 OAuth 客户端注册的回调一致 |
| `reasoningEffort` | `high` | `off` / `low` / `high`；`low`/`high` 仅对 `gemini-3*` 发送 `thinkingLevel` |
| `retryPolicy` | `{ mode: normal, maxRetries: 3 }` | 透传 DSH 重试策略 |
| `proxy` | `{ enabled: false, host: 127.0.0.1, port: 8045 }` | 可选 OpenAI 兼容代理 |
| `usage.enabled` | `true` | 是否记录用量；关闭后不再写库，已有数据保留 |
| `usage.retentionDays` | `0` | 只保留最近 N 天，`0` = 全部保留；在插件加载与设置变更时清理 |
| `usage.pricing` | 内置 11 个模型单价 | 覆盖单价表，形如 `[{ model: gemini-3.8-flash, input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 }]`，单位 USD / 1M tokens |

环境变量覆盖（优先级高于内置客户端，低于设置项）：

```bash
export DSH_ANTIGRAVITY_CLIENT_ID=...
export DSH_ANTIGRAVITY_CLIENT_SECRET=...
```

也兼容旧名 `GOOGLE_ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_ID`。

---

## 凭据存放位置

| 位置 | 用途 |
| --- | --- |
| `~/.dsh/antigravity-accounts.json`（0600） | 账号**清单**：全部账号、凭据、默认账号、冷却与最后使用时间。多账号的唯一事实源 |
| `~/.dsh/antigravity-accounts.json.bak`（0600） | 清空账号（行内「移除」）**之前**留下的上一代备份 —— 那是唯一不可逆的操作，删掉的是无法从别处恢复的 refresh token |
| `ctx.credentials` 记录 `dsh-antigravity/google-antigravity` | DSH 内的默认账号记录；登录流程必须在此提交记录 |
| `~/.dsh/antigravity-auth.json`（0600） | 默认账号的镜像，供独立 CLI / 代理使用，同时兼容已有安装 |
| `GOOGLE_ANTIGRAVITY_DATA` / `GOOGLE_ANTIGRAVITY_TOKEN` | 环境变量注入，优先级最高（在账号池里表现为一个不落盘、不冷却、永远排在最前的 `env` 账号） |

> 登录成功后会写注册表，并把默认账号同时写进 seam 记录与镜像文件；移除账号会同步三者。注册表是**先写同目录临时文件再原子改名**的，所以 CLI 与运行中的 DSH 并发读写时不会读到半截 JSON。任何路径都不会触碰 `~/.omp`。

---

## 架构

```
src/                      TypeScript 源码（NodeNext 风格，import 写 ./x.js）
├── index.ts           Host 插件：自有 settings 命名空间、原生适配器注册、
│                      authorization 登录 flow、/dsh-antigravity/{auth,usage}/* 回环路由、可选代理
├── client.ts          浏览器半：提供方卡片内的多账号管理 UI + 设置页「用量统计」面板
├── adapter.ts         原生 LlmAdapter：请求构造 + SSE → DSH StreamChunk、跨账号故障转移，并观测每次调用
├── accounts.ts        多账号注册表与账号池：清单持久化、选择策略、配额冷却、旧单账号迁移
├── usage-model.ts     纯函数用量模型：词元桶、成本、时间窗、聚合、分桶、分组
├── usage-store.ts     node:sqlite 持久化：幂等写入、窗口查询、统计、保留期清理
├── usage-collector.ts 把观测到的调用补上会话事实（目录 / 主-子代理）后落库
├── usage-routes.ts    用量 API：快照 / 明细 / 状态 / 清理 / 历史导入
├── usage-backfill.ts  从会话日志（多帧 zstd）回溯历史调用
├── auth.ts            OAuth 端点、客户端解析、单条凭据读写、刷新、环境层
├── auth-flow.ts       单次 OAuth 尝试的本地回调监听（Web / flow / CLI 共用）
├── proxy.ts           可选 OpenAI 兼容代理
├── models.ts          模型目录与 id/wireId 解析
├── tool-schema.ts     工具 JSON Schema → Antigravity functionDeclarations 方言投影
└── bin.ts             独立 CLI（login / accounts / logout / status / refresh / proxy）
lib/                      tsc 构建产物（git 忽略，随 npm 包发布）
```

浏览器半（`client.ts` → `lib/client.js`）由 `tsconfig.client.json` 单独编译：DSH 对插件客户端代码
是**原样下发、不做转译**，所以它必须以经典脚本形式产出，`window.__ModuleLoader__.load({...})`
包装结构不能变成 ES module（因此该份配置显式声明 `moduleDetection: "legacy"`，否则 tsc 会追加
`export {};`，在浏览器里直接是语法错误）。

### DSH 集成点

- `ctx.llm.registerAdapter(['google-antigravity'], adapter)` — 原生路由；
- `ctx.llm.registerConfigurableProviders([{ settingsNs: 'llm-antigravity', settingsPath: ['account'], declared: false }])` — 设置页目录条目（非空 path 让它在有账号前只出现在「添加提供方」里）；
- `ctx.settings.installSection(ctx, 'llm-antigravity', Config, ...)` — 自有设置命名空间；
- `ctx.authorization.registerFlow({ key, label, methods, run })` — 无头/ACP 登录；
- `ctx.webServer.register({ kind: 'exact', path: '/dsh-antigravity/auth/...' })` — 浏览器登录回环路由：`status` / `login` / `cancel` / `logout` / `accounts` / `accounts/active` / `accounts/remove`（经 `ctx.connection.requestRejection` 校验）；
- `settings.models.provider-card` 键 `llm-antigravity` — 卡片扩展区；
- `settings.section` id `antigravity-usage` — 设置页「用量统计」；
- `ctx.webServer.register({ kind: 'exact', path: '/dsh-antigravity/usage/…' })` — 用量 API，与登录路由共用同一 guard；
- `ctx.get('sessions')` — 只读地用会话 header 补齐工作目录与「主 / 子代理」标记，服务缺席时降级为空。

### 工具 schema 的 Gemini 方言

`functionDeclarations[].parameters` 被端点当作 protobuf 消息解析：**它不忽略不认识的字段，而是整包拒绝**，返回 `400 INVALID_ARGUMENT`，且只报第一个冒犯者。所以工具 schema 里一个 JSON Schema 关键字就能让整个请求失败——即使那个工具从未被调用。

逐关键字实测（`cloudcode-pa.googleapis.com`，每次请求只差一个关键字）：

| 关键字 | 结果 |
| --- | --- |
| `const` | 400 `Unknown name "const"` |
| `$ref` / `examples` | 400 |
| `allOf` / `anyOf` / `oneOf` / `not` | 接受 |
| `enum` / `pattern` / `format` / `default` | 接受 |
| `minimum` / `maximum` / `minItems` | 接受 |
| `additionalProperties: false` | 接受 |

`const` 正是 DSH 自己会产出的关键字：`cordis_define` 的 `plugin` 参数是 `oneOf` 分支，用 `const: "new" | "existing"` 判别。因此 cordis preset 的 agent 一旦路由到 Antigravity，**首次请求就 400**，而同一份目录换到别的提供方完全正常；受影响的还有子代理——子会话继承父会话的整套工具目录。

`src/tool-schema.ts` 在构造请求前遍历所有可能放 schema 的位置（`properties` / `items` / `oneOf` / `anyOf` / `allOf` / `not` / `additionalProperties`），把 `const: v` 改写成等价的一值 `enum: [v]`，丢掉 `$ref` / `$defs` / `definitions` / `$id` / `$schema` / `examples` 这些自包含参数 schema 用不到的引用与文档关键字，其余原样透传——不认识的未来关键字仍会在端点**响亮地**失败，而不是在这里被悄悄弱化。原生适配器与 OpenAI 兼容代理走同一个投影。

---

## 开发

```bash
pnpm install
pnpm run build             # tsc → lib/（测试与发布均针对 lib/ 产物）
pnpm test                  # 构建后跑全部单元测试（139 宿主/浏览器 + 61 用量），无网络、无真实凭据
pnpm run test:types        # 仅类型检查（Host 半 + 浏览器半两份 tsconfig）
pnpm pack                  # prepack 会自动 build，产物只含 lib/
```

> 改了源码后必须重新构建：运行中的 DSH 与 `dsh list` 消费的是 `lib/` 而不是 `src/`。

### 装进 profile：**每次都要 bump version**

profile 里的依赖是 `file:` 指向 tarball，而 pnpm 把 `file:` 依赖按**路径**判为已满足 ——
覆盖 tarball 但版本号不变时，它**不会**刷新 `node_modules`。实测（pnpm 12.4，临时目录）：

| 手段（tarball 已换、版本号未变） | 是否装上新内容 |
|---|---|
| `pnpm install` | ❌ 报 `Lockfile is up to date, resolution step is skipped` |
| `pnpm install --force` | ❌ 从 store 复用旧内容（`reused 1, downloaded 0`） |
| 只删 `node_modules/<pkg>` 再 install | ❌ 内容不变 |
| 删 `pnpm-lock.yaml` + 整个 `node_modules` 再 add | ✅ |
| `pnpm store prune` + `install --force` | ✅ |
| **bump `package.json` 的 version** 后再 add | ✅ |

所以"源码是 0.3.x、装的是 0.2.x"是默认结果，不是意外。两条对策：

1. **发布/安装一律 bump version**（推荐），或用上表后两种补救；
2. **运行时能问出版本**：插件导出 `version`（从装好的 `package.json` 现读，不会与源码漂移），
   加载时打一行 `dsh-antigravity: v<版本> 已加载`，`/status` 的回执里也带 `version` ——
   排查"我改的为什么没生效"时先看这一行，别猜。

测试覆盖：模型解析、凭据记录封装、OAuth URL、请求构造、工具 schema 投影（`const` / 引用关键字 / 接受关键字 / 缺失 schema 兜底 / `buildRequest` 回归）、SSE 解析、用量映射、Cordis 注册（断言目录条目落在 `llm-antigravity` 而非 `llm-pi-ai`）、浏览器半插槽注册；用量侧另有纯函数口径（词元桶 / 成本 / 缓存节省 / 分桶 / 分组 / 百分位）、采集插桩的成功-失败-中止三条路径、SQLite 幂等写入与窗口查询、快照聚合与行数上限、账户门禁与自动统计的触发条件。

---

## 安全说明

- 内置 OAuth 客户端是 Antigravity 桌面客户端凭据，无法真正保密；请通过 `clientId`/`clientSecret` 设置项或环境变量使用你自己的客户端。
- 回环路由 `/dsh-antigravity/auth/*` 仅在 DSH 的 Web 载体下注册，并经过 Host/Origin 与浏览器认证校验；无 `connection` 服务时不注册。
- OAuth 回调监听 `127.0.0.1:51121` 只在一次登录进行中存在，且无法被本机其他进程利用：回调必须回显本次尝试的 `state`，否则被忽略；任何中止路径都不会产生未处理的 rejection（DSH 的 fail-loud 处理器会因此退出进程）。
- 凭据文件权限为 0600，且不会写入任何第三方应用的数据库。
- 用量库 `~/.dsh/antigravity-usage.db` 权限 0600，只记录本插件这条路由的调用元数据（模型、词元数、耗时、停止原因），不含提示词与响应正文；用量 API 与登录路由共用同一套回环校验。

## License

MIT
