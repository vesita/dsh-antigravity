# dsh-antigravity

DeepSeek Harness (DSH) 的 **Google Antigravity** 模型提供商插件：原生 `LlmAdapter` 实现 + 内置登录 UI + 自有凭据存储。

> **不再依赖 omp。** 旧版会读写 `~/.omp/agent/agent.db` 复用 Oh My Pi 的登录态；本版完全移除了该耦合，凭据只落在 DSH 自己的 `ctx.credentials` 记录与 `~/.dsh/antigravity-auth.json`（0600）中。

---

## 它解决了什么

| 旧版问题 | 本版做法 |
| --- | --- |
| 在 `llm-pi-ai` 命名空间下声明 `providers.google-antigravity`，但 pi-ai 没有该路由的内置目录且配置里没有 `models`，触发 `llm-pi-ai: provider "google-antigravity" resolves no models` | 提供商目录改挂插件自有的 `llm-antigravity` 命名空间；`google-antigravity` 只由原生适配器提供，pi-ai 完全不参与 |
| 只有 CLI 能登录，设置页没有登录入口 | 通过 `settings.models.provider-card` 插槽在「设置 → 模型 → Google Antigravity」卡片内提供登录 / 退出 / 状态 UI |
| 读写 `~/.omp/agent/agent.db`，退出登录会删除 omp 的记录 | 凭据写入 `ctx.credentials`（`dsh-antigravity/google-antigravity` 记录）并镜像到 `~/.dsh/antigravity-auth.json` |
| 每次 DSH 启动都强占 8045 端口跑代理 | OpenAI 兼容代理改为**可选**（`proxy.enabled`，默认关闭） |
| 适配器把带 `thoughtSignature` 的普通文本误判为思考过程；`block-end` 文本错位；工具调用被 `MAX_TOKENS` 覆盖 | 只以 `part.thought === true` 判定思考；块状态机重写；工具调用优先于 `max-tokens` |

---

## 在 DSH 中使用

插件随 profile bundle 加载，无需额外配置即可在模型选择器中出现 `google-antigravity`。

### 账户闭环：没有账户 → 添加 → 登录 → 移除

**默认状态是「没有这一行」。** 插件注册的目录条目 `settingsPath: ['account']`，而 `account` 没有 schema 默认值，于是 `configured` 为假 —— 设置页不会出现 Google Antigravity 行，只在 **添加提供方** 下拉里留一个条目。这满足 DSH 的两条互斥规则：`configured === false` 才进下拉，`configured === true` 才成行（`deepseek-official` 同理，只是它恒为真）。

安装一个账户 = 让那个标记出现。写标记的人就是插件自己：

| 步骤 | 你做什么 | 插件做什么 |
| --- | --- | --- |
| **添加 + 登录** | **设置 → 模型 → 添加提供方 → Google Antigravity**，在卡片里点 **登录 Google 账号** | 起回环监听 `http://127.0.0.1:51121/oauth-callback` 并打开授权页；授权落地后写入凭据，再把 `llm-antigravity.account` 写进 `settings.yaml` —— 行随之出现 |
| **移除** | 行内点 **退出登录**，或行右上角点 **移除** | 两者都清空凭据（记录 + 镜像）并撤掉 `account` 标记，行随之消失，回到下拉里 |
| **取消** | 等待授权时点 **取消**（或关掉授权页直到 10 分钟超时） | 结束本次尝试，卡片说明原因 |

卡片在两种位置都会渲染：下拉里的草稿卡（此时是「添加」）和已经成行的行卡（此时是「管理」）。状态与操作完全一致。标记落地、行出现后**草稿卡立即退场**：原生页面不会替你合上那张草稿卡（写 settings 的是插件自己，没有任何编辑器关闭动作会来清理它），而 `account` 已经让这个条目从下拉里消失 —— 留在原地的卡片会被看成挂在下拉回退显示的那个提供方上。此后状态与操作由行卡独占：

| 卡片状态 | 显示 | 可用的操作 |
| --- | --- | --- |
| 没有账户 | 红点 + 未登录 | **登录 Google 账号** |
| 等待授权 | 黄点 + 等待浏览器完成授权… | **重新打开授权页** / **取消** |
| 凭据过期 | 红点 + 登录已过期，请重新登录 | **登录 Google 账号** |
| 已登录 | 绿点 + 已登录 · 项目 · 令牌有效期 | **退出登录** |

`account` 是**目录标记，不是凭据**：它只记一个可读的标签（邮箱或项目 ID），真正的授权在 `ctx.credentials` 里。两条规则保证两者一致：

- 读卡片时若发现账户存在但标记缺失（例如凭据是 CLI 装的，或来自更早的版本），插件会把标记补上 —— 账户存在就该有行；
- 标记从「有」变「无」时（原生 **移除**、或你手改 `settings.yaml` 删掉它），插件同时删掉凭据。只有这个**状态迁移**会删凭据：CLI 装的凭据从来没有标记，无关的设置改动也不会碰它。

> 原生编辑器的「应用」按钮对非 `llm-deepseek` / `llm-pi-ai` 的命名空间是永久禁用的（DSH 只给这两个布局做了表单），所以「添加」这一步必须由插件自己写 settings —— 光靠页面上的保存按钮，条目会永远卡在下拉里。

同一个插件只维护一份账户：凭据 key 固定为 `dsh-antigravity/google-antigravity`，再次登录是**覆盖**而不是新增。

也可以在终端操作凭据（插件装在 profile 内，所以可执行文件也在 profile 内，不在全局 PATH）。CLI 只碰凭据、不写 settings，所以它登录后行不会自己出现 —— 下次打开那张卡片时会补齐标记：

```bash
D=~/.dsh/profiles/web/node_modules/.bin/dsh-antigravity
$D login      # 浏览器 OAuth 登录
$D status     # 查看登录状态与模型列表
$D logout     # 退出并清除本地凭据
$D refresh    # 强制刷新 access token
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

## 设置项（`~/.dsh/settings.yaml` → `llm-antigravity`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `account` | 未设置 | **账户标记**：存在即表示此账户已安装，设置页才会出现该行。由插件在登录时写入、退出登录/移除时删除；手工删掉它等于移除账户 |
| `models` | 内置 11 个模型 | 可覆盖/增删；每项含 `id`、`wireId`、`name`、`contextWindow`、`maxTokens`、`reasoning`、`inputModalities` |
| `endpoint` | `https://daily-cloudcode-pa.googleapis.com` | 首选端点，失败后回退到内置端点列表 |
| `projectId` | 登录时自动发现 | Antigravity 项目 ID，缺省 `aicode-consumers` |
| `clientId` / `clientSecret` | 内置 Antigravity 客户端 | 可用环境变量覆盖，见下 |
| `redirectUri` | `http://127.0.0.1:51121/oauth-callback` | 必须与 OAuth 客户端注册的回调一致 |
| `reasoningEffort` | `high` | `off` / `low` / `high`；`low`/`high` 仅对 `gemini-3*` 发送 `thinkingLevel` |
| `retryPolicy` | `{ mode: normal, maxRetries: 3 }` | 透传 DSH 重试策略 |
| `proxy` | `{ enabled: false, host: 127.0.0.1, port: 8045 }` | 可选 OpenAI 兼容代理 |

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
| `ctx.credentials` 记录 `dsh-antigravity/google-antigravity` | DSH 内的唯一事实源；登录流程必须在此提交记录 |
| `~/.dsh/antigravity-auth.json`（0600） | 独立 CLI / 代理的镜像，同时兼容已有安装 |
| `GOOGLE_ANTIGRAVITY_DATA` / `GOOGLE_ANTIGRAVITY_TOKEN` | 环境变量注入，优先级最高 |

> 登录成功后会同时写记录与镜像文件；退出登录会清除两者。任何路径都不会触碰 `~/.omp`。

---

## 架构

```
src/                      TypeScript 源码（NodeNext 风格，import 写 ./x.js）
├── index.ts      Host 插件：自有 settings 命名空间、原生适配器注册、
│                 authorization 登录 flow、/dsh-antigravity/auth/* 回环路由、可选代理
├── client.ts     浏览器半：settings.models.provider-card 卡片内登录 UI
├── adapter.ts    原生 LlmAdapter：请求构造 + SSE → DSH StreamChunk
├── auth.ts       OAuth 端点、客户端解析、凭据分层读写、刷新
├── auth-flow.ts  单次 OAuth 尝试的本地回调监听（Web / flow / CLI 共用）
├── proxy.ts      可选 OpenAI 兼容代理
├── models.ts     模型目录与 id/wireId 解析
└── bin.ts        独立 CLI（login / logout / status / refresh / proxy）
lib/                      tsc 构建产物（git 忽略，随 npm 包发布）
```

浏览器半（`client.ts` → `lib/client.js`）由 `tsconfig.client.json` 单独编译：DSH 对插件客户端代码
是**原样下发、不做转译**，所以它必须以经典脚本形式产出，`window.__ModuleLoader__.load({...})`
包装结构不能变成 ES module（因此该份配置显式声明 `moduleDetection: "legacy"`，否则 tsc 会追加
`export {};`，在浏览器里直接是语法错误）。

### DSH 集成点

- `ctx.llm.registerAdapter(['google-antigravity'], adapter)` — 原生路由；
- `ctx.llm.registerConfigurableProviders([{ settingsNs: 'llm-antigravity', settingsPath: [], declared: false }])` — 设置页目录条目；
- `ctx.settings.installSection(ctx, 'llm-antigravity', Config, ...)` — 自有设置命名空间；
- `ctx.authorization.registerFlow({ key, label, methods, run })` — 无头/ACP 登录；
- `ctx.webServer.register({ kind: 'exact', path: '/dsh-antigravity/auth/...' })` — 浏览器登录回环路由（经 `ctx.connection.requestRejection` 校验）；
- `settings.models.provider-card` 键 `llm-antigravity` — 卡片扩展区。

---

## 开发

```bash
pnpm install
pnpm run build             # tsc → lib/（测试与发布均针对 lib/ 产物）
pnpm test                  # 构建后跑 37 项单元测试，无网络、无真实凭据
pnpm run test:types        # 仅类型检查（Host 半 + 浏览器半两份 tsconfig）
pnpm pack                  # prepack 会自动 build，产物只含 lib/
```

> 改了源码后必须重新构建：运行中的 DSH 与 `dsh list` 消费的是 `lib/` 而不是 `src/`。

测试覆盖：模型解析、凭据记录封装、OAuth URL、请求构造、SSE 解析、用量映射、Cordis 注册（断言目录条目落在 `llm-antigravity` 而非 `llm-pi-ai`）、浏览器半插槽注册。

---

## 安全说明

- 内置 OAuth 客户端是 Antigravity 桌面客户端凭据，无法真正保密；请通过 `clientId`/`clientSecret` 设置项或环境变量使用你自己的客户端。
- 回环路由 `/dsh-antigravity/auth/*` 仅在 DSH 的 Web 载体下注册，并经过 Host/Origin 与浏览器认证校验；无 `connection` 服务时不注册。
- OAuth 回调监听 `127.0.0.1:51121` 只在一次登录进行中存在，且无法被本机其他进程利用：回调必须回显本次尝试的 `state`，否则被忽略；任何中止路径都不会产生未处理的 rejection（DSH 的 fail-loud 处理器会因此退出进程）。
- 凭据文件权限为 0600，且不会写入任何第三方应用的数据库。

## License

MIT
