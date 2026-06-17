---
name: wechat-mimocode
description: 微信消息桥接 - 在微信中与 MiMoCode 聊天。支持文字对话、图片识别、文件收发、实时进度推送、斜杠命令。
---

# WeChat MiMoCode Bridge

通过个人微信与本地 MiMoCode CLI 进行对话。基于 [wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) 二次开发，将 Claude Code CLI 替换为 [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code) CLI。

## 前置条件

- Node.js >= 18
- Windows / macOS / Linux（守护进程由 TypeScript 实现，跨平台）
- 个人微信账号（需扫码绑定）
- 已安装 [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code) CLI（`mimo` 命令）并完成认证

## 安装

**方式一：全局安装（推荐）**

```bash
npm install -g wechat-mimocode
```

安装后，任何目录下都可以直接使用 `wechat-mimocode` 命令。

**方式二：从源码安装**

```bash
git clone https://github.com/ch613/WeChat-MiMoCode.git
cd wechat-mimocode
npm install
npm run build
npm install -g .
```

### 验证安装

```bash
wechat-mimocode --version
```

## 触发场景

用户提到"微信桥接"、"微信聊天"、"wechat bridge"、"连接微信"、"微信状态"、"停止微信"、"MiMoCode 微信"等与微信桥接相关的话题时触发。

## 触发后的执行流程

**被触发时，不要直接执行任何操作，先探查当前状态再给出可用操作。**

按顺序检查以下状态：

### 第 1 步：检查是否已安装

如果通过全局 npm 安装，直接验证命令可用：

```bash
wechat-mimocode --version
```

- 如果命令不存在：提示用户执行 `npm install -g wechat-mimocode` 安装。
- 如果命令可用：继续下一步。

### 第 2 步：检查是否已绑定微信账号

```bash
ls ~/.wechat-mimocode/accounts/*.json 2>/dev/null | head -1
```

- 如果没有账号文件：提示用户需要先执行 `wechat-mimocode setup` 扫码绑定，询问是否现在执行。
- 如果有账号文件：继续下一步。

### 第 3 步：检查 daemon 运行状态

```bash
wechat-mimocode daemon status
```

### 第 4 步：根据状态展示信息

**如果 daemon 未运行：**

```
微信桥接已绑定但未运行。

可用操作：
  setup    重新扫码绑定（换号或过期时使用）
  start    启动服务
  logs     查看上次运行的日志
```

**如果 daemon 正在运行：**

```
微信桥接正在运行（PID: xxx）。

可用操作：
  stop     停止服务
  restart  重启服务（代码更新后使用）
  logs     查看运行日志

微信端命令（直接在微信中发送）：
  /help              显示帮助
  /clear             清除当前会话，开始新对话
  /stop              停止当前任务并清空排队消息
  /reset             完全重置（包括工作目录等设置）
  /status            查看当前会话状态
  /compact           压缩上下文（开始新 SDK 会话，保留历史）
  /history [数量]    查看对话记录（默认最近20条）
  /undo [数量]       撤销最近对话（默认1条）
  /cwd [路径]        查看或切换工作目录
  /model [名称]      查看或切换 MiMoCode 模型（格式: provider/model）
  /prompt [内容]     查看或设置系统提示词（全局生效）
  /skills [full]     列出已安装的 skill（full 显示描述）
  /send <路径>       发送本地文件
  /version           查看版本信息
  /<skill> [参数]    触发已安装的 skill
```

如果用户明确指定了操作（如"启动微信"、"停止微信服务"、"看看日志"等），跳过状态展示直接执行对应命令。

## 子命令参考

所有命令通过 `wechat-mimocode` CLI 执行（全局安装后任意目录可用）。

| 命令 | 执行 | 说明 |
|------|------|------|
| setup | `wechat-mimocode setup` | 首次安装向导：生成 QR 码 → 微信扫码 → 配置工作目录 |
| start | `wechat-mimocode daemon start` | 启动后台守护进程（跨平台，基于 PID 文件管理） |
| stop | `wechat-mimocode daemon stop` | 停止守护进程 |
| restart | `wechat-mimocode daemon restart` | 重启守护进程 |
| status | `wechat-mimocode daemon status` | 查看运行状态 |
| logs | `wechat-mimocode daemon logs` | 查看最近日志（stdout/stderr 各最后 50 行） |
| version | `wechat-mimocode --version` | 查看版本 |

> 说明：直接运行 `wechat-mimocode`（不带参数）等同于 `wechat-mimocode start`，会前台启动守护进程。

## 工作原理

```text
微信（手机） ←→ ilink Bot API ←→ Node.js 守护进程 ←→ MiMoCode CLI（本地）
```

守护进程通过长轮询监听微信消息，转发给本地 MiMoCode CLI（`mimo run --format json`）处理，并将 MiMoCode 的回复实时推送回微信。整个流程运行在你自己的电脑上。

## 与上游 wechat-claude-code 的差异

| 项目 | wechat-claude-code | wechat-mimocode |
|------|-------------------|-----------------|
| CLI 命令 | `claude` | `mimo` |
| 输出格式 | `--output-format stream-json` | `--format json` |
| 会话续接 | `--resume <sessionId>` | `--session <sessionId>` |
| 模型格式 | `claude-sonnet-4-6` | `provider/model`，如 `xiaomi/mimo-v2.5` |
| 系统提示 | `--append-system-prompt` | 拼接到 prompt 前部 |
| 图片传递 | 临时文件路径拼接到 prompt | 临时文件 + `-f` 参数 |
| Skill 目录 | `~/.claude/skills/` | `~/.agents/skills/` 与 `~/.local/share/mimocode/compose/*/skills/` |
| 数据目录 | `~/.wechat-claude-code/` | `~/.wechat-mimocode/` |
| 守护进程 | bash 脚本，偏 macOS/Linux | TypeScript 实现，支持 Windows/macOS/Linux |

## 数据目录

所有数据默认存储在 `~/.wechat-mimocode/`：

```
~/.wechat-mimocode/
├── accounts/              # 绑定的微信账号数据（每个账号一个 JSON）
├── config.json            # 全局配置（工作目录、模型、系统提示词）
├── sessions/              # 会话数据（每个账号一个 JSON）
├── mimocode-bridge.pid    # 守护进程 PID 文件
└── logs/                  # 运行日志
    ├── stdout.log
    └── stderr.log
```

可通过环境变量 `WMC_DATA_DIR` 指定数据目录，通过 `WMC_MODEL` 指定默认模型。

## 安全提醒

本项目会把微信消息转发给本地 MiMoCode CLI，并允许 MiMoCode 在指定工作目录内处理任务（使用 `--dangerously-skip-permissions` 跳过权限确认）。请只绑定你信任的微信账号，避免把工作目录设置到敏感路径，并谨慎使用 `/send` 发送本地文件。
