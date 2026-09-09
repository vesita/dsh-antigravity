# dsh-antigravity

适用于 DeepSeek Harness (DSH) 的 Google Antigravity 模型提供商适配器插件（从 Oh My Pi 移植）。

## 功能特性

- **无缝复用 omp OAuth 凭据**：自动读取 `~/.omp/agent/agent.db` 中现有的 Google Antigravity OAuth 认证凭据。如果在 `omp` 中已执行过 `/login google-antigravity`，无需重复登录即可直接使用。
- **OAuth Token 自动刷新**：Access Token 过期时，自动使用 Antigravity 客户端凭证向 Google OAuth 端点（`https://oauth2.googleapis.com/token`）换取新令牌并持久化保存。
- **原生 DSH LlmAdapter 实现**：完整实现 `@deepseek-ai/dsh-llm` 的 `LlmAdapter` 规范，原生支持 DSH 的 `StreamChunk` 事件流（包含 `reasoning-delta` 思考过程、`text-delta` 文本增量、`tool-call-delta` 工具调用及 `usage` Token 统计）。
- **全系列 Antigravity 模型支持**：
  - `gemini-3.8-flash`（映射至 `gemini-3.8-flash-tiered`，1M 上下文，支持多模态）
  - `gemini-3.7-flash`（映射至 `gemini-3.7-flash-tiered`，1M 上下文）
  - `gemini-3.6-flash`（映射至 `gemini-3.6-flash-tiered`）
  - `gemini-3.5-flash`（映射至 `gemini-3.5-flash-low`）
  - `gemini-3.1-pro` / `gemini-3-pro` / `gemini-2.5-pro` / `gemini-2.5-flash`
  - `claude-sonnet-4-6`（通过 Cloud Code Assist 路由）
  - `claude-opus-4-6-thinking`（通过 Cloud Code Assist 路由）
  - `gpt-oss-120b`（映射至 `gpt-oss-120b-medium`）
- **独立内置 OpenAI 兼容代理**：内置轻量 HTTP 代理服务器，可直接为标准 `/v1/chat/completions` 客户端提供服务，亦兼容 DSH Web 界面配置。

---

## 在 DSH 中使用

### 方式一：原生 DSH 插件模式（推荐，零常驻进程）

可直接作为 DSH 插件加载运行。

如需将 `google-antigravity` 设为 DSH 的默认模型，在 `~/.dsh/settings.yaml` 中配置即可：

```yaml
agent-default-model:
  provider: google-antigravity
  model: gemini-3.8-flash
  reasoningEffort: high
```

### 方式二：独立 OpenAI 兼容代理模式

也可以在本地端口启动代理服务：

```bash
dsh-antigravity proxy --port 8045
```

然后在 `~/.dsh/settings.yaml` 中配置自定义提供商：

```yaml
llm-pi-ai:
  providers:
    antigravity:
      displayName: Google Antigravity
      api: openai-completions
      baseURL: http://127.0.0.1:8045/v1
      apiKeyEnv: ANTIGRAVITY_API_KEY
      models:
        - id: gemini-3.8-flash
          contextWindow: 1048576
        - id: claude-sonnet-4-6
          contextWindow: 250000
```

---

## CLI 命令说明

```bash
# 查看认证状态与可用模型列表
dsh-antigravity status

# 登录 Google 账号（发起 OAuth 授权）
dsh-antigravity login

# 退出登录并清除本地存储的凭据
dsh-antigravity logout

# 强制刷新 Google OAuth 访问令牌
dsh-antigravity refresh

# 启动独立 OpenAI 兼容代理服务（默认端口 8045）
dsh-antigravity proxy --port 8045
```
