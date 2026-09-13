# omp（Oh My Pi）`omp stats` 用量统计功能 —— 实测参考文档

> 目的：为「在另一个项目上仿制 omp 用量统计」提供一份基于实测的完整参考。
> 所有结论都标注了证据来源；无法确证的写「未验证」。

## 0. 实测环境与证据强度

| 项 | 值 |
|---|---|
| omp 版本 | `omp/18.1.17` |
| 二进制 | `/usr/bin/omp`，ELF 64-bit，200,857,056 字节，`not stripped` |
| 运行时 | Bun 编译产物（strings 内含 `Bun v`、`Bun/1.4.2`、`bun:sqlite` 导入语句） |
| 统计库 | `~/.omp/stats.db`（8,904,704 字节，WAL 模式，另有 `-shm`/`-wal`） |
| 样本量 | messages 6,717 行 / tool_calls 6,522 行 / user_messages 371 行 / file_offsets 40 行 / meta 8 行 |
| 数据时间跨度 | 2026-08-31 19:44:37 ~ 2026-09-11 20:42:39（本地 CST） |
| 实测时刻 | 2026-09-13 15:2x CST |
| 采集方式 | 全部为只读（sqlite `mode=ro` URI）；dashboard 仅绑 `127.0.0.1:8899`，采集后已 `pkill -f "omp stat[s]"` 关闭 |

证据强度说明：本文的数字均来自**一次**真实库的快照（单次观测，非配对/多 seed 实验）；
公式类结论（如 cacheRate）已用 SQL 逐字节复现到浮点完全一致，标为「已精确复现」；
仅靠读反编译源码片段得出的结论标为「源码级推断」。

---

## 1. 命令面

### 1.1 `omp stats --help`（原文）

```
View usage statistics

USAGE
  $ omp stats [FLAGS]

FLAGS
  -p, --port=<int>    Port for the dashboard server
      --host=<value>  Host to bind
  -j, --json          Output stats as JSON
  -s, --summary       Print summary to console
```

只有 4 个 flag。**没有** `--range` / `--since` / `--days` / `--format` 之类的选项。
实测试过 `--days=365`、`--since=0`、`--all`、`--period=all`、`--range=all`，
全部报错退出（stdout 为空），说明确实是未定义 flag。

### 1.2 三种运行模式

| 命令 | 行为 |
|---|---|
| `omp stats`（无 flag） | 先同步，再打印 `Dashboard available at: http://127.0.0.1:3847` 并常驻（默认端口 3847） |
| `omp stats -s` | 同步 + 向控制台打印 human-readable 摘要，然后退出 |
| `omp stats -j` | 同步 + 向 stdout 打印 JSON，然后退出 |
| `omp stats -p 8899 --host 127.0.0.1` | 起 dashboard，绑定指定 host/port |

### 1.3 `omp stats -s` 的真实输出（原文）

```
Syncing session files...
Synced 0 new entries from 0 files (6717 total)

=== AI Usage Statistics ===

Overall:
  Requests: 0 (0 errors)
  Error Rate: 0.0%
  Total Tokens: 0
  Input Tokens: 0
  Output Tokens: 0
  Cache Rate: 0.0%
  Cache Savings: 0.0%
  Total Cost: $0.0000
  Premium Requests: 0
  Avg Duration: -
  Avg TTFT: -
```

注意两行 stderr/stdout 分工：

- `Syncing session files...` → **stderr**
- `Synced N new entries from M files (K total)` → **stdout**

### 1.4 两个实测到的行为坑（复刻时值得注意）

1. **`-j` 的 stdout 被同步日志污染**：`omp stats -j > f.json` 得到的文件第一行是
   `Synced 0 new entries from 0 files (6717 total)`，其后才是 JSON。
   直接 `json.load()` 会失败，必须先剥掉这一行。实测：文件 683 字节，JSON 从第一个 `{` 开始。
2. **CLI 与 dashboard 共用同一个默认时间窗（24h），且 CLI 无法改**：
   本机数据都产生于 2026-09-11 及之前，距实测时刻 > 24h，所以 `-s` / `-j` 全是 0，
   而同一份库用 `range=all` 查是有 6,717 条请求的。
   证据（已精确复现）：`omp stats -j` 解析出的 `overall` / `byAgentType` / `timeSeries` /
   `modelSeries` / `byFolder` / `costSeries` 与
   `/api/stats/overview?range=24h`、`/api/stats/model-dashboard?range=24h`、
   `/api/stats/folders?range=24h`、`/api/stats/costs?range=24h` 的对应字段
   **逐字段 `==` 相等**。

### 1.5 `omp stats -j` 的 JSON 结构（键名，实测）

```
overall                   # 与 /api/stats/overview 的 overall 同构
byModel                   # = model-dashboard 的 byModel
byFolder                  # = /api/stats/folders 的数组
byAgentType               # = overview 的 byAgentType
timeSeries                # = overview 的 timeSeries
modelSeries               # = model-dashboard 的 modelSeries
modelPerformanceSeries    # = model-dashboard 的 modelPerformanceSeries
costSeries                # = /api/stats/costs 的 costSeries
```

即：`-j` = **overview + model-dashboard + folders + costs 四个 API 的并集**，统一用默认 24h 窗。

`overall` 的全部字段：

```
totalRequests, successfulRequests, failedRequests, errorRate,
totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens,
cacheRate, cacheSavings, totalCost, unpricedRequests, totalPremiumRequests,
avgDuration, avgTtft, avgTokensPerSecond, firstTimestamp, lastTimestamp
```

### 1.6 统计维度清单

「维度」= 结果集的分组键 / 时间桶；「时间范围选项」= dashboard 的 range 枚举。

| 维度名 | 含义 | 数据来源字段 | 出现位置 |
|---|---|---|---|
| 总体（overall） | 全量聚合，无分组 | messages 全表 | `-j`、`/api/stats/overview` |
| byModel | 按 模型 × provider 分组 | `messages.model`、`messages.provider` | `-j`、`/api/stats/model-dashboard` |
| byFolder | 按 项目目录 分组 | `messages.folder` | `-j`、`/api/stats/folders` |
| byAgentType | 按 agent 类型分组（main / subagent） | `messages.agent_type` | `-j`、`/api/stats/overview` |
| byProvider | 按 provider 分组 | `messages.provider` | `/api/stats/providers` |
| timeSeries | 按天桶（UTC 日界）聚合 requests/errors/tokens/cost | `messages.timestamp` | `-j`、overview |
| modelSeries | 按天 × 模型 的请求数 | `messages.timestamp` + `model` | `-j`、model-dashboard |
| modelPerformanceSeries | 按天 × 模型的请求数 + avgTtft + avgTokensPerSecond | 同上 + `ttft`/`duration`/`output_tokens` | `-j`、model-dashboard |
| costSeries | 按天 × 模型 的成本拆分（input/output/cacheRead/cacheWrite） | `messages.cost_*` | `-j`、`/api/stats/costs` |
| byTool / byToolModel | 按 工具 分组 / 工具 × 模型 分组 | `tool_calls.tool_name` + `calls_in_turn` 摊分 | `/api/stats/tools` |
| tool series | 按天 × 工具 的调用数与错误数 | `tool_calls.timestamp` | `/api/stats/tools` |
| behavior | 按天（及按模型）的用户消息摩擦信号计数 | `user_messages.*` | `/api/stats/behavior` |
| hourly（provider） | 按**本地小时**（0-23）聚合 tokens | `messages.timestamp` | `/api/stats/providers` |
| usageSeries / windowInsights | 订阅额度窗口的利用率序列 | `~/.omp/agent/agent.db` 的 `usage_history` 表 | `/api/stats/providers` |
| sessions | 按会话文件聚合 | `messages.session_file` | `/api/sessions` |
| gain | 上下文压缩节省（snapcompact） | gain 子系统，非 messages 表 | `/api/stats/gain` |

时间范围选项（实测自 bundle 中的 `["1h","24h","7d","30d","90d","all"]`）：

| value | 语义 |
|---|---|
| `1h` | 最近 1 小时 |
| `24h` | 最近 24 小时（**默认值**，CLI 与 dashboard 都是） |
| `7d` | 最近 7 天 |
| `30d` | 最近 30 天 |
| `90d` | 最近 90 天 |
| `all` | 全部时间 |

时间桶宽度（源码级推断，来自 bundle 里的窗口描述表）：`7d`→7 桶、`30d`→30 桶、
`90d`→90 桶、`all`→`bucketCount: 0`（自适应），桶宽 `bucketMs` 对 7d/30d/90d 相同，
刻度格式 `MMM d`。本机实测 `range=all` 的 `timeSeries`/`costSeries` 桶时间戳为
`1788134400000`、`1788220800000`、`1788307200000`… 步长恰好 86,400,000 ms = 1 天，
且对齐到 UTC 00:00（`1788134400000` = 2026-08-31T00:00:00Z），**日界是 UTC 不是本地时区**。

输出格式选项：只有 `-s`（人类可读）与 `-j`（JSON）两种；dashboard 是默认模式。

---

## 2. 数据模型

### 2.1 存储布局总览

| 文件 | 大小 | 是否统计来源 | 说明 |
|---|---|---|---|
| `~/.omp/stats.db` | 8.9 MB | **是**（唯一聚合库） | WAL 模式；`busy_timeout=5000`；应用时以可写方式打开，只读可安全访问 |
| `~/.omp/agent/agent.db` | 553 KB | 部分（订阅窗口） | 认证凭据、`usage_history`（provider 额度窗口快照）、缓存、命令计数、模型性能 |
| `~/.omp/agent/history.db` | 721 KB | 否 | 输入提示历史（history + FTS5 + session_titles） |
| `~/.omp/agent/models.db` | 1.6 MB | 未验证 | 未在本次任务范围内打开 |
| `~/.omp/agent/sessions/<folder>/*.jsonl` | — | **原始数据** | 每会话一个 JSONL，stats.db 的唯一 ingest 来源 |

**session 原始数据存放位置（已实测）**：目录结构为
`~/.omp/agent/sessions/<folder>/<ISO时间戳>_<uuid>.jsonl`，
例如 `/tmp` → `~/.omp/agent/sessions/-tmp/2026-09-11T12-35-24-124Z_01a09077-...jsonl`。

**subagent 的 JSONL 布局（实测，直接决定 `agent_type` 从哪来）**：
主会话的 JSONL 位于 `sessions/<folder>/<ISO时间戳>_<uuid>.jsonl` 时，
它的子代理文件位于**同名子目录**里，文件名为子代理名：

```
~/.omp/agent/sessions/-coding-my/2026-08-31T11-48-12-366Z_01a057a6-01ce-7078-84cf-3a3feb028ae0.jsonl      ← main
~/.omp/agent/sessions/-coding-my/2026-08-31T11-48-12-366Z_01a057a6-01ce-7078-84cf-3a3feb028ae0/BackendScout.jsonl   ← subagent
~/.omp/agent/sessions/-coding-my/2026-08-31T11-48-12-366Z_01a057a6-01ce-7078-84cf-3a3feb028ae0/KernelWorker.jsonl   ← subagent
~/.omp/agent/sessions/-coding-my/2026-08-31T11-48-12-366Z_01a057a6-01ce-7078-84cf-3a3feb028ae0/FrontendScout.jsonl  ← subagent
~/.omp/agent/sessions/-coding-my/2026-08-31T11-48-12-366Z_01a057a6-01ce-7078-84cf-3a3feb028ae0/UiOverhaul.jsonl     ← subagent
```

即 `agent_type` 不是数据里写着的，而是**从文件路径推出来的**（`agent_type_v1` 迁移里的
`yns(session_file)` 就是干这个；迁移会 `SELECT DISTINCT session_file FROM messages`
再逐文件回填）。复刻时若也用文件路径判定，务必把这条规则做成**可重新回填**的迁移，
否则一旦布局变了历史数据就再也分不出 main/subagent。

每个 JSONL 首行是 `{"type":"title",...}`，第二行是 `{"type":"session","version":3,"id":...,"cwd":...,"title":...}`，
之后是逐条 entry。带 usage 的 assistant entry 形如：

```json
"usage":{"input":5198,"output":538,"cacheRead":16306,"cacheWrite":0,
 "totalTokens":22042,"reasoningTokens":279,
 "cost":{"input":0.0038985,"output":0.0020175,"cacheRead":0.00122295,"cacheWrite":0,"total":0.00713895}}
```

**关键结论**：`cost` 是 **omp 在请求发生时就算好并写进 JSONL 的**，stats.db 只是搬运工
（`messages.cost_*` 列 = JSONL 里 `usage.cost` 的展开）。见 §4 的 INSERT 语句。
`~/.omp/agent/history.db` 与统计无关（它只有 prompt 文本、FTS 索引、会话标题）。

### 2.2 `messages` 表（6,717 行）

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_file TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  api TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  duration INTEGER,
  ttft INTEGER,
  stop_reason TEXT NOT NULL,
  error_message TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  premium_requests REAL NOT NULL,
  cost_input REAL NOT NULL,
  cost_output REAL NOT NULL,
  cost_cache_read REAL NOT NULL,
  cost_cache_write REAL NOT NULL,
  cost_total REAL NOT NULL,
  cost_no_cache_input REAL,
  agent_type TEXT NOT NULL DEFAULT 'main',
  cost_unpriced INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_file, entry_id)
)
```

| 字段 | 类型 | 含义 | 实测观测 |
|---|---|---|---|
| `id` | INTEGER PK | 自增行号，也是 `/api/request/<id>` 的键 | 最大 8019 |
| `session_file` | TEXT | 来源 JSONL 绝对路径 | 40 个不同文件 |
| `entry_id` | TEXT | JSONL entry 的短 id（如 `75ccdf72`）；与 session_file 组成唯一键 | — |
| `folder` | TEXT | 项目目录的「路径压缩名」：**先去掉 `$HOME` 前缀，再把 `/` 全部换成 `-`**（因此总以 `-` 开头）。实测：`/tmp` → `-tmp`；`/home/vesita/coding/my` → `-coding-my`；`/home/vesita/.cache/paru/clone/deepseek-harness/bin` → `-.cache-paru-clone-deepseek-harness-bin`。同一个值既是 `messages.folder`，也是 `~/.omp/agent/sessions/` 下的目录名 | 8 个：`-coding-my`(3085)、`-coding-my-stross`(2146)、`-coding-my-breeze`(663)、`-coding-my-krice`(318)、`-tmp`(249)、`-coding-my-exreg`(122)、`-coding-my-dsh-collab`(121)、`-.cache-paru-clone-deepseek-harness-bin`(13) |
| `model` | TEXT | 模型 id | `gemini-3.8-flash`(3410)、`gemini-3.7-flash`(2941)、`deepseek-v4-flash-vision-exp`(261)、`claude-opus-4-6`(105) |
| `provider` | TEXT | provider id | `google-antigravity`(6456)、`deepseek`(261) |
| `api` | TEXT | 实际协议方言 | `google-gemini-cli`、`openai-completions` |
| `timestamp` | INTEGER | 请求完成时刻，**毫秒** Unix 时间 | 1788176677417 ~ 1789130559986 |
| `duration` | INTEGER (nullable) | 端到端耗时，**毫秒**（浮点值存进 INTEGER 列，实测有小数如 `12935.078884999995`） | 6,710 行非空（7 行 NULL） |
| `ttft` | INTEGER (nullable) | time-to-first-token，毫秒 | 6,559 行非空（158 行 NULL）；错误请求常为 NULL |
| `stop_reason` | TEXT | 结束原因 | `toolUse`(6388)、`stop`(193)、`error`(130)、`aborted`(6) |
| `error_message` | TEXT (nullable) | 失败详情（原始 provider 错误体，可含多行 JSON） | 例：`Cloud Code Assist API error (429): {...RESOURCE_EXHAUSTED...}`、`Request was aborted` |
| `input_tokens` | INTEGER | **未命中缓存的**输入 token 数 | 合计 48,761,156 |
| `output_tokens` | INTEGER | 输出 token 数 | 合计 2,956,079 |
| `cache_read_tokens` | INTEGER | 从 prompt cache 读取的输入 token | 合计 982,322,807 |
| `cache_write_tokens` | INTEGER | 写入缓存的 token | 合计 0（本机模型都不收 cache write） |
| `total_tokens` | INTEGER | 该次请求的会话总 token（**不是** input+output） | 例：in 2549 + out 491 + cacheRead 84910 = 87950 = total_tokens ✓ |
| `premium_requests` | REAL | 计费的「premium request」数；Copilot 语义，见 §5.4 | 本机全为 0.0 |
| `cost_input` | REAL | 未缓存输入的美元成本 | — |
| `cost_output` | REAL | 输出的美元成本 | — |
| `cost_cache_read` | REAL | 缓存读取的美元成本 | — |
| `cost_cache_write` | REAL | 缓存写入的美元成本 | — |
| `cost_total` | REAL | `= cost_input + cost_output + cost_cache_read + cost_cache_write` | 已逐行验证 |
| `cost_no_cache_input` | REAL | **反事实**：假设这些输入完全不走缓存（即 input+cacheRead+cacheWrite 全按 input 单价计费）会花的钱 | 用于算 cacheSavings |
| `agent_type` | TEXT | `main` / `subagent`（v1 迁移时按 session 目录判定回填） | main 6164、subagent 553 |
| `cost_unpriced` | INTEGER | 0/1，1 表示「这次请求没匹配到定价表」 | 本机全 0 |

索引（8 个，全部服务于 range/分组过滤）：

```
idx_messages_timestamp                       (timestamp)
idx_messages_session                         (session_file)
idx_messages_model                           (model)
idx_messages_folder                          (folder)
idx_messages_timestamp_folder                (timestamp, folder)
idx_messages_timestamp_agent_type            (timestamp, agent_type)
idx_messages_timestamp_model_provider        (timestamp, model, provider)
idx_messages_stop_reason_timestamp           (stop_reason, timestamp)
```

`total_tokens` 的语义已**精确复现**（6,717 行全量校验，0 处不符）：

```
total_tokens = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
```

（不是 `input+output`：例如 `in 2549, out 491, cacheRead 84910, cacheWrite 0 → total 87950` ✓；
另有 `in 250549, out 571, cacheRead 0 → total 251120` ✓。）
这也与 dashboard 上 `Conversation Total` 卡的 tooltip 原文完全一致：
"Uncached input + cache reads + cache writes + output"。
落地建议：**把它当派生列**（或加 CHECK 约束），不要当独立可信输入。

### 2.3 `user_messages` 表（371 行）—— 用户摩擦信号

```sql
CREATE TABLE user_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_file TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  model TEXT,            -- 可为 NULL
  provider TEXT,         -- 可为 NULL
  chars INTEGER NOT NULL,
  words INTEGER NOT NULL,
  yelling INTEGER NOT NULL,
  profanity INTEGER NOT NULL,
  anguish INTEGER NOT NULL,
  negation INTEGER NOT NULL DEFAULT 0,
  repetition INTEGER NOT NULL DEFAULT 0,
  blame INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_file, entry_id)
)
```

| 字段 | 含义 | 实测/源码依据 |
|---|---|---|
| `chars` | 原始用户消息字符数 | 合计 247,025 |
| `words` | 按 `/\S+/g` 切词的个数 | 源码级 |
| `yelling` | 全大写喊叫次数 | 见下 |
| `profanity` | 脏话命中次数 | 命中一个硬编码词表（fuck/shit/…，含 fk/fck/frick/freaking 等变体），用 `\b(?:…)\b` 全局匹配 |
| `anguish` | 「痛苦」信号次数 = 4 个正则命中数之和 | `[!?][!?1]{2,}`（`!!!`/`?!?`）、`\bdude\b`、`(?<=^|[\s.!?])[:;]-?\(+`（`:-(`）、外加一个情绪词表 |
| `negation` | 否定/纠错信号 = 2 个正则命中数之和 | 行首 `no/nope/nah/nvm/wrong/incorrect`（带一长串上下文白名单，避免 `no` 出现在 `no idea` 之类语境）＋ `that's not what I… / not what i meant / makes no sense` |
| `repetition` | 「我早说过了」信号 = 2 个正则 | `like/as i said`、`i meant/said/told you/already did`；`still doesn't/isn't/… /the same` |
| `blame` | 归责信号 = 3 个正则 | `you didn't/did not/broke/missed/forgot/keep/always/never/still/ignored`、`why would/did you`、行首 `stop X-ing` |

**信号计算的前置条件（重要）**：

1. 先做文本规范化（去 markdown/代码块等），再统计。
2. 规范化后为空，或**非空行数 >= 3**（`C8i = 3`）时，**所有信号一律记 0**，只保留 `chars`/`words`。
   即长消息（>=3 行的粘贴日志）刻意不参与情绪打分，避免误判。
3. `yelling` 判定：取每个「全大写片段」，要求片段内词数 >= 4（`tVo = 4`），
   且大写字符占比 > 0.5（`$Vi = 0.5`），并且通过 `b8i` 白名单过滤，才计 1 次。

本机实测：yelling / profanity / anguish / negation / repetition / blame **全部为 0**
（说明该用户在此数据窗口内没触发任何信号；不代表功能失效）。

### 2.4 `tool_calls` 表（6,522 行）

```sql
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_file TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  agent_type TEXT NOT NULL DEFAULT 'main',
  calls_in_turn INTEGER NOT NULL DEFAULT 1,
  args_chars INTEGER NOT NULL DEFAULT 0,
  result_chars INTEGER,
  is_error INTEGER,
  UNIQUE(session_file, tool_call_id)
)
```

| 字段 | 含义 | 实测 |
|---|---|---|
| `tool_name` | 工具名 | `bash`、`read`、`edit`、… 共 13 种 |
| `model` / `provider` | **发起该轮**的模型（同一 turn 内多个工具调用共享） | — |
| `agent_type` | main / subagent | — |
| `calls_in_turn` | 该 turn 内并发发起的工具调用总数。**成本/Token 摊分用**：`SUM(messages.total_tokens / tool_calls.calls_in_turn)` 即「Attributed Tokens」 | SQL 原文见 §4 |
| `args_chars` | 工具入参 JSON 的字符数（"Call Arguments"） | bash 合计 429,074 |
| `result_chars` | 工具回填进上下文的文本字符数（"Result Text"）；可 NULL | bash 合计 2,653,883；read 6,022,405 |
| `is_error` | 0/1，工具执行是否失败 | bash 2238 次调用 / 243 次错误 |

索引：`(timestamp)`、`(tool_name, timestamp)`。

### 2.5 `file_offsets` 表（40 行）—— 增量同步的游标

```sql
CREATE TABLE file_offsets (
  session_file TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  last_modified INTEGER NOT NULL
)
```

同步机制（源码级推断 + 实测印证）：

1. 遍历 `~/.omp/agent/sessions/**/*.jsonl`。
2. `SELECT offset, last_modified FROM file_offsets WHERE session_file = ?` 取上次读到的字节偏移。
3. 只解析**新增字节**，把解析出的 entry 批量插表，然后把新 offset `INSERT OR REPLACE` 回去。
4. 去重规则（`bVo` 里的 INSERT）：
   `WHERE NOT EXISTS (SELECT 1 FROM messages WHERE entry_id = ? AND timestamp = ? AND session_file <> ?)`
   —— 同一 entry 若已存在于**别的** session 文件（fork/复制场景），不再重复计入。
5. 冲突处理：`ON CONFLICT(session_file, entry_id) DO UPDATE SET premium_requests = MAX(...), cost_* = excluded.*`
   —— 重新 ingest 会**刷新成本字段**而不改其他列，这是为了定价表更新后能回溯修正历史成本。
6. `file_offsets` 是「强制全量重建」的开关：任何 schema/口径迁移都会 `DELETE FROM file_offsets`
   并把 `meta` 里对应迁移标记置回 `pending`，下一次同步即全库重建。

实测印证：`/api/sync` 与 `omp stats -j` 返回 `{"processed":0,"files":0,"totalMessages":6717}`
—— 0 个新文件、0 条新 entry，但库里仍是 6,717 条（偏移已到文件末尾）。

**`/api/stats/*` 的 range 过滤不查 file_offsets，只查 messages.timestamp**；
file_offsets 纯粹是 ingest 层游标。

### 2.6 `meta` 表（8 行）—— 迁移/口径版本标记

```
agent_type_v1                complete
fork_dedupe_v1               complete
user_messages_v8             complete
tool_calls_v1                complete
user_message_links_v1        complete
premium_requests_priority_v1 complete
messages_cost_reingest_v1    complete
messages_cost_unpriced_v1    complete
```

每个键对应一次「口径变更」，值是状态机 `pending` / `complete`（源码里 `NW="pending"`、`rpe="complete"`）。
迁移函数在每次打开库时运行；若值不是 `complete`，就 `DELETE FROM file_offsets` 触发全量重算。
复刻建议：**这个模式非常值得照抄**——统计口径一定会改，把「口径版本 + 全量重建」做成幂等迁移
比写补数据脚本可靠得多。

### 2.7 `agent.db` / `history.db` 的定位

`~/.omp/agent/agent.db`（与统计相关的部分）：

| 表 | 行数 | 是否被 stats 使用 |
|---|---|---|
| `usage_history` | 237 | **是**：`recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status, resets_at`，被 `packages/stats/src/usage-windows.ts` 只读打开，喂给 `/api/stats/providers` 的 `usageSeries` / `windowInsights` |
| `model_perf` | 4 | 未在 stats 中引用（`model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms`）—— 疑似别处用于估算 |
| `model_usage` | 4 | 同上，仅 `last_used_at` |
| `usage_history` 之外的 `auth_credentials`、`clients`、`client_usage`、`command_usage`、`cache`、`settings` | — | 与统计无关（认证/缓存/命令计数） |

`~/.omp/agent/history.db`：只有 `history`（prompt、cwd、session_id）、`history_fts`（FTS5）与
`session_titles`。**与用量统计无关**。

⚠️ 实证：`usage_history` 的 `account_key` 形如 `oauth|email:a01056628203@gmail.com|project:aicode-consumers`，
含账号邮箱。若复刻时要暴露类似面板，需要做脱敏（omp 的 dashboard 在 `accountLabel` 里直接回显了邮箱）。

---

## 3. Dashboard 信息架构

### 3.1 服务实现（实测响应头）

```
$ curl -D - http://127.0.0.1:8899/
HTTP/1.1 200 OK
Content-Type: text/html;charset=utf-8
x-omp-stats-dashboard: 3
x-omp-stats-hostname: 127.0.0.1
content-length: 790
Date: ...
```

- 运行时是 **Bun**（二进制内含 `Bun/1.4.2`，且源码里 `import { Database as sYi } from "bun:sqlite"`），
  HTTP 服务由 Bun 内建 server 提供，**没有 `Server:` 头**（不是 nginx/express 签名）。
- 自定义头只有两个：`x-omp-stats-dashboard: 3`（dashboard 版本号）与
  `x-omp-stats-hostname: <绑定 host>`。
- 静态资源内嵌在二进制里（bundle），由同一 server 提供：
  `/` → 790 B 的 HTML 壳；`/index.js` → 753,870 B（含 React + Chart.js 的整包）；
  `/styles.css` → 44,630 B。
- SPA 回退：请求未匹配的**非 `/api` 路径**（如 `/app.js`）返回 200 + 同一个 HTML 壳；
  未匹配的 `/api/*` 返回 `404 Not Found` + `content-type: application/octet-stream`。
- `OPTIONS /api/sync` 返回 `200`，`Content-Length: 0`（无 CORS 头）。
- `/api/sync` **GET 和 POST 都可用**（前端实际用无 method 的 GET）。两者都返回同一个 JSON。
- 源码里有 `packages/stats/src/port-conflict.ts`，说明端口被占时有专门的冲突处理
  （具体策略**未验证**）。
- 源码文件清单（从二进制内保留的 `// packages/...` 注释提取，共 2,343 条路径）中与统计直接相关的：

```
packages/stats/src/aggregator.ts        # 聚合查询（各 /api/stats/* 的 SQL）
packages/stats/src/db.ts                # schema + 迁移 + 写入
packages/stats/src/parser.ts            # JSONL → entry 解析
packages/stats/src/sync-worker.ts       # 增量同步
packages/stats/src/server.ts            # HTTP 路由
packages/stats/src/trace.ts             # 会话 trace 构建
packages/stats/src/user-metrics.ts      # 摩擦信号
packages/stats/src/gain-aggregator.ts   # 压缩节省
packages/stats/src/usage-windows.ts     # 订阅额度窗口（读 agent.db）
packages/stats/src/embedded-client.ts   # 内嵌前端资源
packages/stats/src/port-conflict.ts
packages/coding-agent/src/cli/stats-cli.ts
packages/coding-agent/src/commands/stats.ts
```

### 3.2 全局壳（每个页面都有）

| 元素 | 内容 / 行为 |
|---|---|
| 左侧导航 | 固定 11 个 tab（见 3.3），窄屏折叠成抽屉 |
| Logo | `OH MY PI` + `Observability` |
| 版本标 | `OMP Stats v1.0.0`（注意：与 HTTP 头的 `x-omp-stats-dashboard: 3` 是两套版本号） |
| 页面标题 | 当前 tab 的 label |
| 最后更新时间 | `Updated HH:MM:SS`，hover 显示完整时间戳 |
| Range 选择器 | segmented control：1h / 24h / 7d / 30d / 90d / all，**默认 24h** |
| 主题切换 | light / dark / system 三态；写 `localStorage["omp-stats-theme"]`；`<head>` 里有防闪的内联脚本 |
| `Sync DB` 按钮 | 调 `/api/sync`，完成后刷新 |
| 路由 | hash 路由：`#/<section>?range=<r>&s=<sessionFile>`，可深链到某个会话 trace |
| 自动刷新 | 所有 tab 都 `pollMs: 30000`（30 秒轮询）；tools 的 trace 子视图是 `15000` |
| 移动端 | 表格有 `renderMobileCard` 变体，窄屏渲染卡片而非表格 |

### 3.3 11 个 tab 的信息架构

区块 → 展示字段 → 交互。

#### 1) Overview

| 区块 | 展示字段 | 交互 |
|---|---|---|
| 4 张主指标卡 | `API-equivalent estimate`(totalCost)、`Requests`、`Cache Savings`、`Cache Rate`（后两者带 tooltip 解释公式） | hover tooltip |
| 8 张次指标卡 | `Uncached Input`、`Cache Read`、`Output Tokens`、`Conversation Total`、`Premium Requests`、`Tokens/s`、`Avg Latency`、`Avg TTFT` | — |
| `Conversation Tokens by Agent` 面板 | 按 agent_type 的 token 堆叠条 + 明细：Main agent(粉) / Subagents(紫) / Advisor(青)；「Uncached input + cache reads + cache writes + output」 | — |
| `System Throughput` 面板 | 双折线：requests 与 errors 的 timeSeries（副标题 "Request volume and errors over time"） | Chart.js 折线，hover tooltip |
| `Operational Feed` / `Recent Requests Preview` | 最近最多 50 条请求表：Model(+provider 副行)、Time、Tokens、API-equivalent estimate、Duration、Status(Success/Failed 徽标) | 点行 → 打开请求详情抽屉 |

#### 2) Requests

单面板 `All Recent Requests`（"Up to 50 most recent requests processed by OMP"），
列与 Overview 的预览表**完全相同**（Model/Time/Tokens/API-equivalent estimate/Duration/Status）。
交互：点行开抽屉；空态文案 `No recent requests found`。

#### 3) Traces

| 区块 | 展示字段 | 交互 |
|---|---|---|
| `Sessions` 表 | Title、Project、Started、Duration、Requests、Tools、Agents、Tokens、Cost、Models（"Recent sessions with subagent activity folded in — click one to open its trace"） | 搜索框 `Filter by title, project, model…`；点行进入 trace 视图 |
| Trace 时间线 | 顶部 summary：Duration / Turns / Requests / Tool Calls / Agents / Tokens / Cost(+unpriced 标记)；泳道 `turn / model / tool / subagent / background`（图例：Input / Model / Tools / Agents / Bg）；每条 span 有 label、start、end、duration、ttft、cost、isError；`markers`（如 `model_change`、`session_exit`） | 时间轴缩放/平移；coloring 按 kind（turn 绿/model 紫/tool 琥珀/subagent 蓝）；错误 span 红；`Real wall-clock time` / `Equal width per user turn` / `Equal width per model/tool call boundary` 三种刻度模式；`Refresh trace`、`Search spans…` |
| 多 track | 每个 subagent 一条 track，含 `parentId`、`label`、`agent`、`model`、`file` | — |

#### 4) Errors

单面板 `Recent Errors`（"Up to 50 most recent failed requests in the stats database"）。
列：Model、Time、Error Message、Tokens、API-equivalent estimate。
交互：点行开抽屉（看完整错误体 + Raw Entry）。数据 = `stop_reason='error'` 的记录，
按时间倒序，`limit` 默认服务端 100 / 前端传 50。

#### 5) Models

| 区块 | 展示字段 | 交互 |
|---|---|---|
| `Model Preference` 面板 | 占比折线：各模型请求数占 `range` 内总请求的百分比（y 轴 0-100%） | 可展开每模型 |
| `Model Statistics` 表 | Model、Requests、API-equivalent estimate、Tokens、Tokens/s、TTFT，可展开显示 Error rate / Latency / Cache rate / Cache savings / Efficiency | 行可展开（无列排序） |

#### 6) Providers

| 区块 | 展示字段 | 交互 |
|---|---|---|
| `Provider Totals` 表 | Provider、Requests、Error Rate、Models、Tokens、Share、API-equivalent estimate、Tok/s | — |
| `Burn by Provider` | 按天 × provider 的 tokens/成本折线（series：timestamp、provider、totalTokens、cost、unpricedRequests、requests） | 图例可切换 |
| `Peak Burn Hours` | 24 小时柱状图，subtitle 会写"peak at HH:00" | `All providers` 下拉筛选 |
| `Subscription Windows` 表 | Provider、Window、Accounts、Windows Burned、Est. Tokens / Window、Peak Utilization、Ideal Accounts、Exhaustions | — |
| `Window Utilization` | 每个账号 × 窗口的最新额度条：`usedFraction*100`，`>=80%` 琥珀，`exhausted` 红色 | provider 下拉（多于 1 个 provider 时出现） |

数据源：`usageSeries` / `windowInsights` 来自 `agent.db.usage_history`，其余来自 `messages`。

#### 7) Tools

| 区块 | 展示字段 | 交互 |
|---|---|---|
| 4 张主指标卡 | Tool Calls、Tools Used、Error Rate、Attributed API-equivalent estimate | — |
| 4 张次指标卡 | Attributed Tokens、Attributed Output、Result Text、Call Arguments | — |
| `Tool Usage` | 工具清单（"Tokens and API-equivalent estimates are split from invoking turns across each turn's tool calls"） | — |
| `Calls Over Time` | 按天 × 工具堆叠折线（calls / errors） | — |
| `By Tool` 表 | Tool、Calls、Error Rate、Attr. Tokens、Attr. API-equivalent estimate、Result Text、Last Used（"Usage per tool, most called first"） | — |
| `By Model` 表 | Tool、Model、Calls、Error Rate、Attr. Tokens、Attr. API-equivalent estimate（"Which models call which tools"） | `All tools` 下拉筛选 |
| 工具延迟表 | Tool、Calls、Errors、Total、Avg、Max | — |
| Raw JSON 抽屉 | `Copy raw JSON`、`Raw Entry` | 点击查看原始 entry |

#### 8) Costs

单面板，图 `Daily API-equivalent estimate`，堆叠按 `costInput` / `costOutput` /
`costCacheRead` / `costCacheWrite`（`costSeries` 的字段），按天 × 模型。
**没有成本明细表**——只有图 + tooltip。

#### 9) Behavior

| 区块 | 展示字段 | 交互 |
|---|---|---|
| 6 个信号卡 | `Yelling (CAPS)`、`Profanity`、`Anguish (!!!, nooo, ugh, dude, ':(')`、`Negation (no/nope/wrong, makes no sense)`、`Repetition (i meant, still doesnt)`、`Blame (you didnt, why did you, stop X-ing)` | 6 个可切换的指标选择器，用于下面的合图 |
| `Frustration (neg + rep + blame)` | 三个信号的合成 | — |
| `User Friction Signals` | 折线：`<选中信号> as % of user messages per day` | 指标多选 |
| `All signals combined` | 全信号叠加 | — |
| `Behavior Signals by Model` 表 | Model、Messages、CAPS %、Profanity %、Anguish %、Frustration %、Hits %、Trend（"Rates are per user message"） | — |

#### 10) Projects

单面板 `Projects & Folders` 表（"Aggregate proxy metrics grouped by folder path"）：
Project/Folder、Requests、API-equivalent estimate、Tokens、Cache Rate、Cache Savings、Error Rate、Avg Duration。

#### 11) Gain（上下文压缩节省）

| 区块 | 展示字段 | 交互 |
|---|---|---|
| 4 张主指标卡 | Saved Tokens、Saved Bytes、Reduction、Total Hits | — |
| `Overall Gain` | "Aggregate snapcompact savings"：savedTokens/savedBytes/hits/outputBytes/originalBytes/reductionPercent | — |
| `By Source` | 按子系统（`snapcompact`）拆分 savings（"Savings breakdown per subsystem"） | 可折叠 |
| `Savings Over Time` | 按天堆叠柱/线：Daily token savings | — |

> 本机实测：gain 全为 0（`overall` 各字段 0、`reductionPercent: null`、`timeSeries: []`），
> 说明这台机器没用过 snapcompact，该子系统**行为未验证**。

### 3.4 交互能力总览（实测）

| 能力 | 有无 | 说明 |
|---|---|---|
| 时间范围切换 | 有 | 1h/24h/7d/30d/90d/all，全局，写进 hash |
| 深链 | 有 | `#/<tab>?range=<r>&s=<sessionFile>` |
| 自动轮询 | 有 | 30s（trace 15s） |
| 主题切换 | 有 | light/dark/system，localStorage |
| 行点击抽屉 | 有 | 请求详情：metrics 网格 + `Raw Request Metadata` + `Raw Entry` + `Copy raw JSON` |
| 图表 | 有 | Chart.js（折线/堆叠折线/柱状/堆叠柱/水平条） |
| 表格排序 | **无** | 共享表格组件 `Ma` 只渲染 `thead/tbody`，没有 sort 状态 |
| 分页 | **无** | 固定 `LIMIT`：recent 50、errors 50、sessions 100 |
| 列筛选下拉 | 有（局部） | providers 的 provider 下拉、tools 的 `All tools`、gain 的 `All projects` |
| 文本搜索 | 有（局部） | traces 的 `Filter by title, project, model…`、trace 视图的 `Search spans…` |
| 导出 | **无**（只有 `Copy raw JSON`） | — |
| 竖屏适配 | 有 | 表格降级为 mobile card |

---

## 4. API 端点清单

全部 15 个端点（`/api/sync` 来自静态字符串 `"/api/sync"`，其余来自模板字面量 grep）。
下面每个都贴**实测真实响应**（已剪裁）。

### 4.1 统计聚合类

#### `GET /api/stats/overview?range=<r>`

```json
{
 "overall": {"totalRequests":6717,"successfulRequests":6587,"failedRequests":130,
  "errorRate":0.019353878219443205,"totalInputTokens":48761156,"totalOutputTokens":2956079,
  "totalCacheReadTokens":982322807,"totalCacheWriteTokens":0,"cacheRate":0.952708840647539,
  "cacheSavings":0.8568570498127516,"totalCost":123.0195798102,"unpricedRequests":0,
  "totalPremiumRequests":0,"avgDuration":6435.937214339795,"avgTtft":4858.8455922817575,
  "avgTokensPerSecond":69.67452891315145,
  "firstTimestamp":1788176677417,"lastTimestamp":1789130559986},
 "byAgentType": [
  {"agentType":"main","totalRequests":6164,"totalInputTokens":45100850,"totalOutputTokens":2575927,
   "totalCacheReadTokens":939420137,"totalCacheWriteTokens":0,"totalCost":115.63108006019999},
  {"agentType":"subagent","totalRequests":553,...,"totalCost":7.38849975}],
 "timeSeries": [
  {"timestamp":1788134400000,"requests":1629,"errors":31,"tokens":313133292,"cost":40.220010975}, ...]
}
```

注意 `byAgentType` 的元素**只有**请求数/四类 token/成本，没有 duration/ttft。
`range` 缺省或非法值都返回 200 + 空窗（**不报错**，实测 `?range=bogus` 与不带 range 都是全 0）。

#### `GET /api/stats/model-dashboard?range=<r>`

```json
{
 "byModel": [{"model":"gemini-3.8-flash","provider":"google-antigravity",
   "totalRequests":3410,"successfulRequests":3357,"failedRequests":53,
   "errorRate":0.015542521994134898,"totalInputTokens":20802298,"totalOutputTokens":1255779,
   "totalCacheReadTokens":466724061,"totalCacheWriteTokens":0,"cacheRate":0.9573309265930379,
   "cacheSavings":0.8615978339337341,"totalCost":55.315199325,"unpricedRequests":0,
   "totalPremiumRequests":0,"avgDuration":5899.6043811479285,"avgTtft":4779.648029475325,
   "avgTokensPerSecond":65.4326660646006,
   "firstTimestamp":1788437747878,"lastTimestamp":1789130559986}, ...],
 "modelSeries": [{"timestamp":1788134400000,"model":"claude-opus-4-6",
   "provider":"google-antigravity","requests":79}, ...],
 "modelPerformanceSeries": [{"timestamp":1788134400000,"model":"claude-opus-4-6",
   "provider":"google-antigravity","requests":79,"avgTtft":3469.371533666664,
   "avgTokensPerSecond":33.41257113254021}, ...]
}
```

#### `GET /api/stats/costs?range=<r>`

```json
{"costSeries":[
 {"timestamp":1788134400000,"model":"claude-opus-4-6","provider":"google-antigravity",
  "cost":4.7895075,"unpricedRequests":0,"costInput":1.23635,"costOutput":0.580125,
  "costCacheRead":2.9730325,"costCacheWrite":0,"requests":79}, ...]}
```

#### `GET /api/stats/folders?range=<r>`

顶层是**数组**（不是对象），元素与 `model-dashboard.byModel` 同构，只是把 `model/provider` 换成 `folder`：

```json
[{"folder":"-coding-my","totalRequests":3085,"successfulRequests":3009,"failedRequests":76,
  "errorRate":0.024635332252836303,"totalInputTokens":27925876,"totalOutputTokens":1490147,
  "totalCacheReadTokens":479702136,"totalCacheWriteTokens":0,"cacheRate":0.9449875197194595,
  "cacheSavings":0.8508387022274062,"totalCost":67.84842615,"unpricedRequests":0,
  "totalPremiumRequests":0,"avgDuration":6850.21957903377,"avgTtft":5219.704258543688,
  "avgTokensPerSecond":72.86488247389443,
  "firstTimestamp":1788176677417,"lastTimestamp":1788612040902}, ...]
```

#### `GET /api/stats/providers?range=<r>`

```json
{
 "providers": [{"provider":"google-antigravity","totalRequests":6456,"failedRequests":130,
   "models":3,"totalInputTokens":48516493,"totalOutputTokens":2729290,
   "totalCacheReadTokens":944748023,"totalCacheWriteTokens":0,"totalTokens":995993806,
   "totalCost":122.81661667499999,"unpricedRequests":0,"totalPremiumRequests":0,
   "avgTokensPerSecond":68.90929043795116}, ...],
 "hourly": [{"provider":"deepseek","hour":16,"totalTokens":17057830,"outputTokens":114250,"requests":123}, ...],
 "series": [{"timestamp":1788134400000,"provider":"google-antigravity","totalTokens":313133292,
   "cost":40.220010975,"unpricedRequests":0,"requests":1629}, ...],
 "usageSeries": [{"provider":"google-antigravity",
   "accountKey":"oauth|email:a01056628203@gmail.com|project:aicode-consumers",
   "accountLabel":"a01056628203@gmail.com",
   "windowKey":"google-antigravity:anthropic:default:3p-5h",
   "windowLabel":"Usage (Anthropic) · 5 Hour",
   "points":[{"timestamp":1788440284736,"usedFraction":0,"exhausted":false}, ... 29 points]}, ...],
 "windowInsights": [{"provider":"google-antigravity",
   "windowKey":"google-antigravity:google:default:daily","windowLabel":"Usage (Google) · Daily",
   "accounts":1,"cycles":5,"fractionConsumed":2.6516508,"estTokensPerWindow":375612734,
   "peakConcurrentFraction":1,"idealAccounts":2,"exhaustedEvents":2}, ...]
}
```

`hourly` 的 `hour` 是 **0-23 本地小时**；不同 provider 各自一组。

#### `GET /api/stats/tools?range=<r>`

```json
{
 "byTool": [{"tool":"bash","calls":2238,"errors":243,"argsChars":429074,"resultChars":2653883,
   "totalTokensShare":351772042.5,"outputTokensShare":562190.1666666666,
   "costShare":38.30283311516666,"unpricedRequestsShare":0,"lastUsed":1788963594773}, ...13 项],
 "byToolModel": [{"tool":"bash","calls":1151,"errors":112,"argsChars":166653,"resultChars":1433378,
   "totalTokensShare":162450450.83333334,"outputTokensShare":232655,"costShare":17.1066496375,
   "unpricedRequestsShare":0,"lastUsed":1788963594773,
   "model":"gemini-3.8-flash","provider":"google-antigravity"}, ...39 项],
 "series": [{"timestamp":1788134400000,"tool":"ask","calls":1,"errors":0},
   {"timestamp":1788134400000,"tool":"bash","calls":523,"errors":67}, ...95 项]
}
```

摊分 SQL（源码原文，`calls_in_turn` 的用途）：

```sql
SUM(COALESCE(m.total_tokens,0) * 1.0 / t.calls_in_turn) AS total_tokens_share,
SUM(COALESCE(m.output_tokens,0) * 1.0 / t.calls_in_turn) AS output_tokens_share,
SUM(COALESCE(m.cost_total,0) / t.calls_in_turn)    AS cost_share,
SUM(<unpriced_expr> * 1.0 / t.calls_in_turn)       AS unpriced_requests_share,
MAX(t.timestamp)                                   AS last_used
```

#### `GET /api/stats/behavior?range=<r>`

```json
{
 "overall": {"totalMessages":371,"totalYelling":0,"totalProfanity":0,"totalAnguish":0,
   "totalNegation":0,"totalRepetition":0,"totalBlame":0,"totalChars":247025,
   "firstTimestamp":1788176677418,"lastTimestamp":1789130558095},
 "byModel": [{"model":"gemini-3.7-flash","provider":"google-antigravity","totalMessages":203,
   "totalYelling":0,"totalProfanity":0,"totalAnguish":0,"totalNegation":0,"totalRepetition":0,
   "totalBlame":0,"totalChars":230505,"lastTimestamp":1788522496958}, ...],
 "behaviorSeries": [ ... 27 项 ]
}
```

注意 `byModel` 里出现了 `{"model":"unknown","provider":"unknown"}`（33 条）——
`user_messages.model` 可为 NULL，API 层兜底成字面量 `"unknown"`。

#### `GET /api/stats/errors?range=<r>&limit=<n>`

顶层是**数组**。`limit` 前端传 50，服务端缺省 100（实测不带 limit 返回 100 条）。

```json
[{"id":8018,
  "sessionFile":"/home/vesita/.omp/agent/sessions/-tmp/2026-09-11T12-35-24-124Z_01a09077-2b5c-74b0-8ee4-d814e14f037e.jsonl",
  "entryId":"f3a5372e","folder":"-tmp","model":"gemini-3.8-flash",
  "provider":"google-antigravity","api":"google-gemini-cli","timestamp":1789130408940,
  "duration":12935.078884999995,"ttft":null,"stopReason":"error",
  "errorMessage":"Cloud Code Assist API error (429): {\n  \"error\": {\n    \"code\": 429,\n    \"message\": \"Resource has been exhausted (e.g. check quota).\",\n    \"status\": \"RESOURCE_EXHAUSTED\"\n  }\n}\n",
  "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,
    "premiumRequests":0,
    "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
  "agentType":"main","costUnpriced":false}, ...]
```

`limit` 上限未验证（只测了 50/100）。

#### `GET /api/stats/recent?limit=<n>`

与 errors 的元素同构（但取全部 stop_reason，按时间倒序）：

```json
[{"id":8019,"sessionFile":"...","entryId":"75ccdf72","folder":"-tmp",
  "model":"gemini-3.8-flash","provider":"google-antigravity","api":"google-gemini-cli",
  "timestamp":1789130559986,"duration":null,"ttft":null,"stopReason":"aborted",
  "errorMessage":"Request was aborted",
  "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,
    "premiumRequests":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
  "agentType":"main","costUnpriced":false}, ...]
```

#### `GET /api/stats/gain?range=<r>[&project=<p>]`

```json
{"overall":{"savedTokens":0,"savedBytes":0,"hits":0,"outputBytes":0,
  "originalBytes":0,"reductionPercent":null},
 "bySource":{"snapcompact":{"savedTokens":0,"savedBytes":0,"hits":0,"outputBytes":0,
  "originalBytes":0,"reductionPercent":null}},
 "timeSeries":[], "project":null, "projects":[]}
```

### 4.2 会话 / Trace / 请求详情

#### `GET /api/sessions?limit=<n>[&q=<search>]`

```json
[{"file":"/home/vesita/.omp/agent/sessions/-tmp/2026-09-11T12-35-24-124Z_01a09077-2b5c-74b0-8ee4-d814e14f037e.jsonl",
  "folder":"-tmp","title":"Continue previous response",
  "startedAt":1789130199784,"endedAt":1789130559992.8682,
  "requests":5,"toolCalls":0,"subagents":0,"totalTokens":0,"costTotal":0,
  "unpricedRequests":0,"models":["gemini-3.8-flash"]},
 {"title":"Niri Native Workflow Optimization","requests":103,"toolCalls":103,
  "totalTokens":6233500,"costTotal":0.8853435, ...}]
```

`q` 是子串匹配（对 title/project/model）；实测 `?limit=2&q=stats` 返回 `[]`
（**不是** 400/500，也不是模糊匹配）。前端固定传 `limit=100`，且 `q` 只在**前端**做过滤时也传。

#### `GET /api/session/trace?file=<urlencoded 绝对路径>`

```json
{"file":"/home/.../2026-09-11T12-35-24-124Z_..._01a09077....jsonl",
 "title":"Continue previous response","cwd":"/tmp",
 "startedAt":1789130164192,"endedAt":1789130559993,"mtimeMs":1789130559992.8682,
 "tracks":[{"id":"main","parentId":null,"label":"Main","agent":null,
   "model":"gemini-3.8-flash","file":"/home/.../*.jsonl",
   "markers":[{"time":1789130124163,"kind":"model_change","label":"google-antigravity/gemini-3.8-flash"},
              {"time":1789130559983,"kind":"session_exit","label":"normal"}],
   "spans":[
     {"id":"main:bea06dbc","kind":"turn","start":1789130164192,"end":1789130199786,
      "label":"帮我将dsh更新到这个版本，用buildpkg的方式，需要sudo的命令可以告诉我","entryId":"bea06dbc"},
     {"id":"main:2596da50","kind":"model","start":1789130199784,"end":1789130199786,
      "label":"gemini-3.8-flash","entryId":"2596da50","model":"gemini-3.8-flash",
      "cost":0,"isError":true}, ...]}],
 "summary": {...}}
```

`kind` 的全部取值（实测 + 源码）：`turn` / `model` / `tool` / `subagent` / `background`。
track 的 `label` 取值为 `Main` / `Main agent` / `Subagents` / `Advisor`。

#### `GET /api/session/entry?file=<path>&id=<entryId>`

```json
{"entry":{"type":"message","id":"75ccdf72","parentId":"ffcd401e",
  "timestamp":"2026-09-11T12:42:39.994Z",
  "message":{"role":"assistant","content":[],"api":"google-gemini-cli",
    "provider":"google-antigravity","model":"gemini-3.8-flash",
    "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,
      "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
    "stopReason":"aborted","errorMessage":"Request was aborted",
    "errorId":134221824,"timestamp":1789130559986,"completedAt":1789130559993}}}
```

即「原始 JSONL entry 的直出」。

#### `GET /api/request/<id>`（id = messages.id）

```json
{"id":8019,"sessionFile":"...","entryId":"75ccdf72","folder":"-tmp",
 "model":"gemini-3.8-flash","provider":"google-antigravity","api":"google-gemini-cli",
 "timestamp":1789130559986,"duration":null,"ttft":null,"stopReason":"aborted",
 "errorMessage":"Request was aborted",
 "usage":{"input":0,...,"cost":{...}},"agentType":"main","costUnpriced":false,
 "messages":[{"type":"message","id":"75ccdf72","parentId":"ffcd401e",
   "timestamp":"2026-09-11T12:42:39.994Z","message":{...}}],
 "output":"..."}
```

比 errors/recent 的元素多两个字段：`messages`（该轮相关 entry 数组）与 `output`（模型输出文本）。

### 4.3 运维

#### `GET|POST /api/sync`

```json
{"processed":0,"files":0,"totalMessages":6717}
```

`processed` = 本次新 ingest 的 entry 数，`files` = 有新增的文件数，
`totalMessages` = 同步后 messages 总行数。前端 `Sync DB` 按钮调它。

### 4.4 端点汇总表

| 端点 | 方法 | 参数 | 返回形状 |
|---|---|---|---|
| `/api/stats/overview` | GET | `range` | object(overall, byAgentType[], timeSeries[]) |
| `/api/stats/model-dashboard` | GET | `range` | object(byModel[], modelSeries[], modelPerformanceSeries[]) |
| `/api/stats/costs` | GET | `range` | object(costSeries[]) |
| `/api/stats/folders` | GET | `range` | **array** |
| `/api/stats/providers` | GET | `range` | object(providers[], hourly[], series[], usageSeries[], windowInsights[]) |
| `/api/stats/tools` | GET | `range` | object(byTool[], byToolModel[], series[]) |
| `/api/stats/behavior` | GET | `range` | object(overall, byModel[], behaviorSeries[]) |
| `/api/stats/errors` | GET | `range`, `limit`（默认 50/100） | **array** |
| `/api/stats/recent` | GET | `limit` | **array** |
| `/api/stats/gain` | GET | `range`, `project?` | object(overall, bySource, timeSeries[], project, projects[]) |
| `/api/sessions` | GET | `limit`, `q?` | **array** |
| `/api/session/trace` | GET | `file` | object(file, title, cwd, startedAt, endedAt, mtimeMs, tracks[], summary) |
| `/api/session/entry` | GET | `file`, `id` | object(entry) |
| `/api/request/:id` | GET | path id | object(...messages[], output) |
| `/api/sync` | GET/POST | — | object(processed, files, totalMessages) |

---

## 5. 成本与定价口径

### 5.1 已精确复现的公式

用一条 SQL 对 6,717 行的全量聚合，与 API 返回值逐位比对：

| 指标 | 公式 | 验证结果 |
|---|---|---|
| `cacheRate` | `SUM(cache_read_tokens) / (SUM(input_tokens) + SUM(cache_read_tokens))` | 0.952708840647539 **完全一致** |
| `cacheSavings` | `1 - (SUM(cost_input)+SUM(cost_cache_read)+SUM(cost_cache_write)) / SUM(cost_no_cache_input)` | 0.8568570498127517 vs API 0.8568570498127516，**浮点末位一致** |
| `successfulRequests` | `COUNT(*) WHERE stop_reason <> 'error'` | 6587 **完全一致**（`aborted` 仍算成功） |
| `failedRequests` | `COUNT(*) WHERE stop_reason = 'error'` | 130 **完全一致** |
| `errorRate` | `failedRequests / totalRequests` | 0.019353878219443205 **完全一致** |
| `avgTtft` | `AVG(ttft)` 且**只对 ttft 非 NULL 的行**求均值 | 4858.8455922817575 **完全一致** |
| `avgDuration` | `AVG(duration)` 且**只对 duration 非 NULL 的行** | 6435.937214339795 **完全一致** |
| `cost_total` | `cost_input + cost_output + cost_cache_read + cost_cache_write` | 逐行成立 |

`avgTokensPerSecond` 是唯一**没能精确复现**的字段：API 报 69.67452891315145，
而 `SUM(output_tokens)/SUM(duration)` = 68.4506、`SUM(output_tokens)/SUM(duration-ttft)` = 261.23、
按行求平均 = 30,586.88。已穷举 7 种行过滤 × 2 种分子 × 2 种分母共 28 种组合，
**无一命中**；推测是「按模型/按请求先算比率再加权」或带离群值裁剪。**标记为未验证**。

### 5.2 定价来源：JSONL 里的 `usage.cost`，由 omp 内嵌定价表在请求时算好

- stats.db 的 `cost_*` 列**不是** stats 模块自己算的，而是搬运自 session JSONL
  的 `usage.cost`（见 §2.1 的 JSONL 样例与 §4 的 INSERT 原文）。
- omp 二进制内**保留了可读的定价表源码**（Bun 打包未做压缩混淆），例如：

```js
"gemini-3.8-flash": {
  id: "gemini-3.8-flash", name: "Gemini 3.8 Flash",
  api: "google-generative-ai", provider: "google",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  reasoning: true, input: ["text","image"],
  cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  contextWindow: 1048576, maxTokens: 65536, int: 58.7, tps: 326.9, ...
}
```

- 定价单位是**美元 / 1M tokens**，四个维度：`input` / `output` / `cacheRead` / `cacheWrite`。

### 5.3 用真实账单反推的单价表（交叉验证）

对每个模型做 `SUM(cost_x) / SUM(tokens_x) * 1e6`，得到的「隐含单价」与二进制里的定价表**完全吻合**：

| model | provider | api | input | output | cacheRead | cacheWrite |
|---|---|---|---|---|---|---|
| `gemini-3.7-flash` | google-antigravity | google-gemini-cli | 0.75 | 3.75 | 0.075 | — |
| `gemini-3.8-flash` | google-antigravity | google-gemini-cli | 0.75 | 3.75 | 0.075 | — |
| `claude-opus-4-6` | google-antigravity | google-gemini-cli | 5.00 | 25.00 | 0.500 | — |
| `deepseek-v4-flash-vision-exp` | deepseek | openai-completions | 0.14 | 0.28 | 0.0028 | — |

（「—」= 该窗口内 cacheWrite token 为 0，无法反推，非 0 值。）单位：USD / 1M tokens，实测值。

### 5.4 口径推断与反例

1. **`cacheRead` 相对 `input` 的倍率不固定**，取决于模型：
   gemini 系 = input 的 **1/10**（0.075/0.75）；claude-opus = **1/10**（0.5/5.0）；
   deepseek-vision = **1/50**（0.0028/0.14）。所以**不能**写死「cache read 打 1 折」，
   必须按模型取定价表。
2. **`cost_no_cache_input` 是反事实字段**，不是实际支出：
   它等于 `(input + cacheRead + cacheWrite) × input 单价`（逐行验证：`cost_no_cache_input/(input+cacheRead)`
   对 gemini 恒为 0.75、对 claude-opus 恒为 5.0、对 deepseek 恒为 0.15）。
   它的用途只有一个：算 `cacheSavings`。
   **⚠️ 实测到一个不一致**：deepseek-vision 的 `cost_no_cache_input` 隐含单价是 **0.15**，
   而 `cost_input` 用的是 **0.14**。即同一模型存在两个不同的 input 单价。
   二进制里该模型确实带 `timeBased: { offPeakMultiplier: 0.5, peakWindows: {...}, effectiveRates: {...} }`
   以及 `costPatch: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }` 结构，
   但**峰谷价的具体套用规则未能从字符串里确认**。标记为**未验证**：复刻时若要支持
   「分时定价」，需要另找证据，不要照抄 0.15/0.14 这组数字。
3. **`cacheSavings` 可能为负**：主指标卡的 tooltip 原文就写
   "cache writes can make this negative"。本机 `cache_write_tokens` 全 0，故未观察到负值。
4. **`premium_requests` 是 GitHub Copilot 的语义，被 omp 泛化了**。源码（实测片段）：

```js
function Y2s(e, t) {                       // e = premiumMultiplier, t = planTier
  const s = e ?? 1;
  if (Mxr(t) === "free" && s === 0) return 1;
  return s;
}
function $2s(e) {
  if (e.initiator === "agent") return 0;   // agent 自发的请求不计 premium
  return Y2s(e.premiumMultiplier, e.planTier);
}
```

   即：**按 `X-Initiator` 判定**——`agent`（工具/agent 自动发起）计 0，
   用户发起的按该模型的 `premiumMultiplier` 计（Copilot 模型目录里的字段，
   二进制里见到的取值有 `0.33` / `0.25` / `3` / `0`），free 套餐且倍率为 0 时兜底为 1。
   `messages.premium_requests` 列存的就是这个值，**可以是小数**（列类型 REAL 佐证）。
   本机全 0，因为所有模型都走 `google-antigravity`/`deepseek` 而非 Copilot，也没有非 agent initiator
   之外的计费。（`agent` 判定的其余细节**未验证**。）
5. **`cost_unpriced = 1` 的判定条件（源码原文，可直接照抄）**：

```sql
CASE WHEN total_tokens > 0 AND cost_total = 0
     AND (provider = 'xai-oauth' OR cost_unpriced = 1) THEN 1 ELSE 0 END
```

   即「有 token 消耗、但成本算出来是 0」时，标记为「未定价」，
   且 `xai-oauth` provider 被硬编码视为未定价。UI 里这个标记会跟在成本后面
   （`costTotal` + `unpricedRequests` 一起传给格式化函数 `ea(...)`）。
   本机 `cost_unpriced` 与 `unpricedRequests` **全 0**。

### 5.5 从二进制提取定价表的可行做法（供复刻参考）

```bash
strings -n 4 /usr/bin/omp > /tmp/omp.strings      # 2,387,800 行
grep -n -A14 '"gemini-3\.8-flash"' /tmp/omp.strings | grep -E 'name:|cost:|contextWindow'
```

二进制里保留了两类东西：
1. **模型目录全量条目**（`id/name/api/provider/baseUrl/cost/contextWindow/maxTokens/thinking/...`）
   以及 `Pq("provider/model", "Name", {input,output}, contextWindow, ["text"])` 形式的第三方目录；
2. `// packages/<pkg>/src/<file>.ts` 形式的**源文件路径注释**（2,343 条），
   可以据此还原 omp 的模块划分，对「复刻哪些能力」很有帮助。
成本：`strings` 一次约 10 秒量级，grep 若干条即可，属于低成本、高回报。

---

## 6. 在 DSH 上要复刻哪些能力（优先级建议）

判断依据：哪些能力**决定了这套统计是否可解释、可行动**，哪些只是锦上添花。
DSH 已有的天然优势：`~/.dsh` 下已经有会话记录，且 DSH 的 session/entry 模型与 omp 的
JSONL entry 同构，因此「JSONL → 聚合库」这条链路可以照搬。

### P0 —— 必须有（没有这套统计就不成立）

| # | 能力 | 为什么 | 关键实现点 |
|---|---|---|---|
| P0-1 | **会话 JSONL 增量 ingest**：`file_offsets(session_file, offset, last_modified)` + 只读新增字节 | 决定统计的「真实性与实时性」；全量扫描在会话变多后会成为瓶颈 | 按字节偏移续读；`(session_file, entry_id)` 唯一键；offset 写回 |
| P0-2 | **messages 主表**：timestamp / model / provider / api / duration / ttft / stop_reason / error_message / 四类 token / 四类 cost / total_tokens / agent_type | 所有上层面板都由它派生 | 建 `(timestamp)`、`(timestamp, model, provider)`、`(timestamp, folder)`、`(timestamp, agent_type)` 组合索引（omp 的 8 个索引就是按 range+分组 设计的） |
| P0-3 | **range 过滤**：1h/24h/7d/30d/90d/all，默认 24h | 这是用户 90% 的用法 | 一个 `sinceTimestamp(range)` 函数 + 所有查询共用；桶对齐 UTC 日界 |
| P0-4 | **overview 聚合**：totalRequests / successful / failed / errorRate / 四类 token / cacheRate / cacheSavings / totalCost / unpricedRequests / avgDuration / avgTtft / first-last timestamp | 首页四张主卡 + 八张次卡的全部数据 | 公式见 §5.1，`cacheSavings` 要用 `cost_no_cache_input` 反事实字段，别自己重算 |
| P0-5 | **分组聚合**：byModel / byProvider / byFolder(项目) / byAgentType | 「哪个模型/哪个项目在烧钱」是最核心的可行动信息 | 每个分组复用同一份聚合 SQL，只换 GROUP BY 列 |
| P0-6 | **成本口径**：四维单价表（input/output/cacheRead/cacheWrite，USD per 1M）+ `cost_no_cache_input` + `cost_unpriced` | 没有成本口径就只是 token 计数器 | **定价表要可配置/可更新**；用 `meta` 里的口径版本触发重算（见 P0-7） |
| P0-7 | **口径版本迁移表（meta + 强制全量重建）** | 口径一定会改；`DELETE FROM file_offsets` 让重建变成幂等操作，比补丁脚本可靠 | 照抄 omp 的 `key=口径名, value=pending/complete` 状态机 |
| P0-8 | **时间序列**：requests/errors/tokens/cost 按天 | 趋势图是唯一的「异常发现」手段 | 按 range 决定桶宽与桶数 |
| P0-9 | **只读 + 本地绑定**：dashboard 默认绑 127.0.0.1；统计库以只读方式对本进程外的访问 | omp 的库含邮箱等敏感信息 | 默认 host=127.0.0.1，不做 0.0.0.0 |

### P1 —— 值得有（显著提升可用性）

| # | 能力 | 为什么 |
|---|---|---|
| P1-1 | **tool_calls 表 + `calls_in_turn` 摊分** | 「哪个工具的 token 成本最高」是优化 agent 循环的直接依据；摊分规则必须显式（否则同一 turn 内多工具的成本会重复计） |
| P1-2 | **请求详情抽屉**：原始 entry JSON + 完整 errorMessage + 单请求 tokens/cost/ttft | 排障入口；omp 把它做成所有表格的通用行点击行为 |
| P1-3 | **errors 面板**（按 range 取最近 N 条失败请求，含 errorMessage） | 429/超时这类 provider 问题的唯一可见入口 |
| P1-4 | **sessions 列表 + 单会话 trace 时间线** | 把「统计」变成「可回溯」；trace 的 turn/model/tool/subagent 泳道复用 messages+tool_calls 两张表即可构建，不必新存数据 |
| P1-5 | **duration / ttft / tokens-per-second 的性能三件套** | 判断 provider 是否退化；`avgTokensPerSecond` 公式未复现，DSH 可以自己定义清楚（建议 `SUM(output)/SUM(duration)` 并在 UI 标注口径） |
| P1-6 | **agent_type 维度（main / subagent）** | 子代理是成本黑洞的主要来源之一 |
| P1-7 | **json 输出（`stats -j`）** | 便于脚本/CI 消费；**注意**：omp 在这里踩了「同步日志污染 stdout」的坑，DSH 应当把日志一律送 stderr |
| P1-8 | **30 秒轮询自动刷新 + 手动 Sync** | 长会话中看着数字涨是刚需 |

### P2 —— 可选（有则更好，缺了不影响）

| # | 能力 | 备注 |
|---|---|---|
| P2-1 | user_messages 摩擦信号（yelling/profanity/anguish/negation/repetition/blame） | 有趣但**本机实测全 0**，价值未经真实数据验证；且正则规则很脆（>=3 行就整体跳过）。若要做，建议先只做 `chars/words` + `negation/blame` |
| P2-2 | 订阅额度窗口（usageSeries / windowInsights / Window Utilization） | 依赖 provider 是否暴露 quota；omp 是从 `agent.db.usage_history` 读的，DSH 侧不适用 |
| P2-3 | gain / snapcompact 压缩节省 | **本机实测全 0**，行为完全未验证；只在 DSH 有等价压缩子系统时才有意义 |
| P2-4 | Providers 面板的 `hourly` 24 小时「Peak Burn Hours」 | 展示效果好，实现廉价（一条 GROUP BY hour） |
| P2-5 | 多 provider 占比 / 模型占比（Model Preference） | 由 byModel 派生，成本极低 |
| P2-6 | CSV 导出、表格列排序、分页 | **omp 都没有**（它只有固定 LIMIT + 行点击）。DSH 若做，属于超出 omp 的增强 |
| P2-7 | 主题切换、移动端卡片布局、hash 深链 | 纯前端体验 |
| P2-8 | `x-<product>-stats-dashboard: <ver>` 之类的自描述响应头 | 实现廉价、排障友好，建议顺手加 |

### 明确**不建议**照抄的点

| 项 | 原因 |
|---|---|
| `stats -j` 把同步日志打到 stdout | 破坏 JSON 可解析性（实测需手动剥首行） |
| CLI 的时间窗写死为默认 24h、且没有 `--range` | 用户无法用 CLI 查历史；实测 `omp stats -s` 因数据超 24h 而全 0，极易误判为「功能坏了」 |
| `avgTokensPerSecond` 的可疑口径 | 我未能复现（28 种组合全不中）；DSH 应显式定义并写清分母 |
| `accountLabel` 直接回显邮箱 | 隐私；UI 层应脱敏 |

---

## 7. 未验证清单（诚实边界）

| # | 项 | 状态 |
|---|---|---|
| 1 | `avgTokensPerSecond` 的确切公式 | **未验证**：穷举 28 种组合未命中，报 69.6745，最接近的 `SUM(out)/SUM(duration)` = 68.4506 |
| 2 | deepseek-vision 的峰谷分时定价套用规则（为何 `cost_input` 用 0.14 而 `cost_no_cache_input` 用 0.15） | **未验证**：只确认了二进制里存在 `timeBased`/`peakWindows`/`effectiveRates` 结构 |
| 3 | `/api/stats/errors` 的 `limit` 上限与截断行为 | **未验证**：只测了 50/100 |
| 4 | 端口冲突时的具体行为（`port-conflict.ts` 的存在已确认，策略未测） | **未验证** |
| 5 | gain / snapcompact 子系统的真实数据形态 | 本机全 0，`timeSeries: []`，**行为未验证** |
| 6 | 摩擦信号在真实触发时的计数是否合理 | 本机六个信号全 0，**未验证** |
| 7 | `premium_requests` 的 `initiator` 判定细节（除 `agent` 外的分支） | 只确认 `agent → 0` 与该模型的 `premiumMultiplier` 分支 |
| 8 | `timeSeries` 的桶边界在 `1h`、`7d` 等短窗下是否仍按 UTC 日界 | 只在 `all` 的日桶上验证了对齐 UTC 00:00 |
| 9 | CLI 分页/多页 JSON（数据量大时 `-j` 是否会截断） | 本机 24h 窗为空，**未验证** |
| 10 | `models.db`（1.6 MB）与统计的关系 | 未打开 |

---

## 附录 A：本次实测的原始产物

| 路径 | 内容 |
|---|---|
| `/tmp/omp-stats/stats.json` | `omp stats -j` 原始输出（含被污染的首行） |
| `/tmp/omp-stats/index.html` | dashboard HTML 壳（790 B） |
| `/tmp/omp-stats/index.js` | dashboard 前端整包（753,870 B） |
| `/tmp/omp-stats/styles.css` | 样式（44,630 B） |
| `/tmp/omp-stats/api-*.json` | 15 个端点的真实响应（含 `range=all` 与 `range=24h` 两组） |
| `/tmp/omp-stats/omp.strings` | `strings -n 4 /usr/bin/omp` 的产物（2,387,800 行，含内嵌定价表与源码路径） |
| `/tmp/omp-stats/pricing-candidates.txt` | 提取出的定价条目候选 |
| `/tmp/omp-stats/server.log` | dashboard 启动日志 |

> 注：`/tmp/omp-stats/*` 为临时产物；本报告引用的数字都可从这些文件复现。
>
> **只读合规说明**：我方没有对 `~/.omp` 下任何文件执行写操作——所有直接数据库访问都用
> `file:...?mode=ro` URI。需要说明的是，`omp stats -s` / `-j` / `-p` 每条命令都会先跑
> **omp 自己的**同步流程（它自己会以读写方式打开 `stats.db`），因此 `stats.db` 的 mtime 在实测期间
> 被 omp 更新过（15:22 → 15:30）。同步结果为「0 new entries from 0 files」，
> 采集前后行数一致（messages 6717、tool_calls 6522、user_messages 371、file_offsets 40），
> 内容未变。
>
> dashboard 采集完毕后已用 `pkill -f "omp stat[s]"` 关闭，并确认 8899 端口拒绝连接；
> 仓库侧 `git status --porcelain` 只有 `?? notes/`，未改动任何其他文件。
