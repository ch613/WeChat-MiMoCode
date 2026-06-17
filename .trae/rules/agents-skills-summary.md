# Codex 与 OpenCode 的 Agent 和 Skill 汇总

本文档汇总了本机 Codex CLI 和 OpenCode 的 agent、skill、配置信息，供 Trae agent 参考使用。

---

## 一、Codex CLI

### 基本信息

- 配置目录：`~/.codex/`
- 全局指令文件：`~/.codex/AGENTS.md`（当前为空）
- 配置文件：`~/.codex/config.toml`
- Skills 目录：`~/.codex/skills/`
- 默认模型：`gpt-5.4`（reasoning effort: high）
- 模型提供商：自定义（`https://sub.yu-cloud.cn/v1`）
- Windows 沙箱模式：`elevated`

### Codex Skills 列表

#### 系统内置 Skills（`~/.codex/skills/.system/`）

| Skill | 说明 |
|-------|------|
| imagegen | OpenAI 图片生成（含脚本 image_gen.py、remove_chroma_key.py） |
| openai-docs | OpenAI 文档查询（最新模型、提示指南、升级指南） |
| plugin-creator | Codex 插件创建工具 |
| skill-creator | Skill 创建工具（含 openai.yaml 生成、快速验证脚本） |
| skill-installer | 从 GitHub 安装 Skill |

#### 用户安装 Skills（`~/.codex/skills/`）

| Skill | 说明 |
|-------|------|
| app-store-changelog | App Store 发布说明生成 |
| bug-hunt-swarm | Bug 猎手集群 |
| cli-creator | CLI 创建工具 |
| easyeda-api | 立创EDA API 集成（含完整类/枚举/接口参考文档） |
| gh-address-comments | GitHub PR 评论处理 |
| gh-fix-ci | GitHub CI 修复 |
| github | GitHub 操作 |
| ios-debugger-agent | iOS 调试代理 |
| keil-firmware-verification | Keil 固件验证 |
| macos-menubar-tuist-app | macOS 菜单栏 Tuist 应用 |
| macos-spm-app-packaging | macOS SPM 应用打包 |
| oh-my-openagent | OmO 多 agent 编排插件（详见下文） |
| orchestrate-batch-refactor | 批量重构编排 |
| pdf | PDF 处理 |
| project-skill-audit | 项目 Skill 审计 |
| react-component-performance | React 组件性能优化 |
| review-and-simplify-changes | 代码审查与简化 |
| review-swarm | 代码审查集群 |
| swift-concurrency-expert | Swift 并发专家 |
| swiftui-liquid-glass | SwiftUI Liquid Glass |
| swiftui-performance-audit | SwiftUI 性能审计 |
| swiftui-ui-patterns | SwiftUI UI 模式 |
| swiftui-view-refactor | SwiftUI 视图重构 |

---

## 二、OpenCode

### 基本信息

- 配置目录：`~/.config/opencode/`
- 配置文件：`~/.config/opencode/opencode.json` 和 `opencode.jsonc`
- Skills 目录：`~/.config/opencode/skills/`
- 当前默认模型：`agnes ai/agnes-2.0-flash`
- 插件：`oh-my-openagent@latest`、`opencode-antigravity-auth`、`opencode-axonhub-tracing`、`opencode-omit-max-tokens`、`opencode-openai-codex-auth`、`opencode-gemini-auth`

### OpenCode 已配置的模型提供商

| 提供商 | baseURL | 可用模型 |
|--------|---------|----------|
| OpenAI | `https://sub.yu-cloud.cn/v1` | gpt-5.4, gpt-5.5 |
| bigmodel | `https://open.bigmodel.cn/api/paas/v4` | glm-5-turbo, glm-5.1 |
| OpenAI-mf | `https://api.chatanywhere.tech/v1` | gpt-5.4-ca, deepseek-v4-pro, gpt-5.5-ca |
| Open | `https://api.sanyang.chat/v1` | gpt-5.5, gpt-5.4 |
| deepseek | `https://api.deepseek.com/v1` | deepseek-v4-flash, deepseek-v4-pro |
| xiaomimimo | `https://api.xiaomimimo.com/v1` | mimo-v2-flash, mimo-v2.5 |
| mimo-auto | `http://localhost:10000/v1` | mimo/mimo-auto |
| agnes ai | `https://apihub.agnes-ai.com/v1` | agnes-video-v2.0, agnes-2.0-flash, agnes-image-2.0-flash |

> 注意：大部分提供商已被 `disabled_providers` 禁用，当前仅启用 `agnes ai`。

### OpenCode Skills 列表

| Skill | 说明 |
|-------|------|
| easyeda-api | 立创EDA API 集成（含完整参考文档和格式规范） |
| oh-my-openagent | OmO 多 agent 编排插件（详见下文） |

---

## 三、oh-my-openagent (OmO) — 核心多 Agent 系统

OmO 是同时安装在 Codex 和 OpenCode 中的多 agent 编排插件，提供 11 个专业 agent、8 个任务类别、40+ hooks、内置 skills 和多提供商模型路由。

- 仓库：https://github.com/code-yeongyu/oh-my-openagent
- 配置文件：`~/.config/opencode/oh-my-opencode.json`（或 `oh-my-openagent.jsonc`）

### 11 个 Agent

| Agent | 角色 | 默认模型 | 回退链 |
|-------|------|----------|--------|
| **Sisyphus** | 主编排器，用户直接交互 | claude-opus-4-6 | glm-5 → big-pickle |
| **Hephaestus** | 深度工作者（代码密集型） | gpt-5.3-codex | 无（需 GPT） |
| **Oracle** | 架构顾问（只读，不写代码） | gpt-5.4 | gemini-3.1-pro → claude-opus-4-6 |
| **Librarian** | 文档和参考搜索（后台运行） | gemini-3-flash | minimax-m2.5-free → big-pickle |
| **Explore** | 快速代码搜索（后台运行） | grok-code-fast-1 | minimax-m2.5-free → claude-haiku-4-5 → gpt-5-nano |
| **Multimodal-Looker** | 视觉/图像分析 | gpt-5.3-codex | k2p5 → gemini-3-flash → glm-4.6v → gpt-5-nano |
| **Prometheus** | 规划器 | claude-opus-4-6 | gpt-5.4 → gemini-3.1-pro |
| **Metis** | 规划顾问（规划前分析） | claude-opus-4-6 | gpt-5.4 → gemini-3.1-pro |
| **Momus** | 规划审查器 | gpt-5.4 | claude-opus-4-6 → gemini-3.1-pro |
| **Atlas** | Todo 编排器 | claude-sonnet-4-6 | gpt-5.4 |
| **Sisyphus-Junior** | 委派任务执行者 | 依赖类别 | — |

### 8 个任务类别

| 类别 | 适用场景 | 默认模型 | 回退链 |
|------|----------|----------|--------|
| **visual-engineering** | 前端、UI/UX、设计 | gemini-3.1-pro | glm-5 → claude-opus-4-6 |
| **ultrabrain** | 高难度逻辑任务 | gpt-5.4 (xhigh) | gemini-3.1-pro → claude-opus-4-6 |
| **deep** | 自主问题解决 | gpt-5.3-codex (medium) | claude-opus-4-6 → gemini-3.1-pro |
| **artistry** | 创造性、非常规方法 | gemini-3.1-pro (high) | claude-opus-4-6 → gpt-5.4 |
| **quick** | 简单单文件修改 | claude-haiku-4-5 | gemini-3-flash → gpt-5-nano |
| **unspecified-low** | 低强度杂项 | claude-sonnet-4-6 | gpt-5.3-codex → gemini-3-flash |
| **unspecified-high** | 高强度杂项 | claude-opus-4-6 (max) | gpt-5.4 → glm-5 → k2p5 → kimi-k2.5 |
| **writing** | 文档、技术写作 | gemini-3-flash | claude-sonnet-4-6 |

### 6 个内置 Skills

| Skill | 领域 | 用途 |
|-------|------|------|
| **playwright** | 浏览器自动化 | 验证、浏览、网页抓取、测试、截图 |
| **playwright-cli** | Playwright CLI | 运行测试套件、生成测试 |
| **agent-browser** | 高级浏览器自动化 | 复杂多步骤浏览器工作流 |
| **dev-browser** | 持久化浏览器自动化 | 导航网站、填表、截图、数据提取 |
| **git-master** | Git 操作专家 | 原子提交、rebase/squash、历史搜索 |
| **frontend-ui-ux** | 前端设计开发 | UI/UX 制作（无需设计稿） |

### 8 个斜杠命令

| 命令 | 说明 |
|------|------|
| `/ralph-loop` | 启动自引用开发循环，自主工作直到完成 |
| `/ulw-loop` | 启动 ultrawork 循环 |
| `/cancel-ralph` | 取消活跃的 Ralph Loop |
| `/start-work` | 从 Prometheus 计划启动工作会话 |
| `/refactor` | 智能重构（LSP、AST-grep、TDD 验证） |
| `/init-deep` | 初始化分层 AGENTS.md 知识库 |
| `/handoff` | 创建上下文摘要以在新会话中继续 |
| `/stop-continuation` | 停止所有继续机制 |

### Skill 加载位置（优先级顺序）

1. `.opencode/skills/*/SKILL.md`（项目级，OpenCode 原生）
2. `~/.config/opencode/skills/*/SKILL.md`（用户级，OpenCode 原生）
3. `.claude/skills/*/SKILL.md`（项目级，Claude Code 兼容）
4. `.agents/skills/*/SKILL.md`（项目级，Agents 约定）
5. `~/.agents/skills/*/SKILL.md`（用户级，Agents 约定）

### Agent 配置选项

所有 agent 支持在 `oh-my-opencode.json` 中覆盖：

| 选项 | 类型 | 说明 |
|------|------|------|
| model | string | 覆盖默认模型 |
| fallback_models | string[] | 覆盖回退链 |
| temperature | number | 采样温度 |
| top_p | number | 核采样 |
| prompt | string | 替换整个系统提示 |
| prompt_append | string | 追加到系统提示 |
| tools | string[] | 限制可用工具 |
| disable | boolean | 禁用该 agent |
| variant | string | 成本变体（low/medium/high/xhigh/max） |
| maxTokens | number | 最大输出 token |
| thinking | boolean | 启用扩展思考 |
| reasoningEffort | string | 推理努力级别 |

---

## 四、Trae 中的使用参考

当用户在 Trae 中提到以下话题时，可参考本文档：

- "codex 的 agent" / "opencode 的 agent" → 查看第三节
- "怎么配置 OmO" / "oh-my-openagent" → 查看第三节
- "codex 有哪些 skill" → 查看第一节
- "opencode 有哪些 skill" → 查看第二节
- "怎么切换模型" → 查看 agent/类别配置选项
- "斜杠命令" → 查看斜杠命令表

### 配置文件路径速查

| 用途 | 路径 |
|------|------|
| Codex 全局配置 | `~/.codex/config.toml` |
| Codex 全局指令 | `~/.codex/AGENTS.md` |
| Codex Skills | `~/.codex/skills/*/SKILL.md` |
| OpenCode 配置 | `~/.config/opencode/opencode.json` |
| OpenCode 配置（详细） | `~/.config/opencode/opencode.jsonc` |
| OpenCode Skills | `~/.config/opencode/skills/*/SKILL.md` |
| OmO 配置 | `~/.config/opencode/oh-my-opencode.json` |
| OmO 配置（详细） | `~/.config/opencode/oh-my-openagent.jsonc` |
