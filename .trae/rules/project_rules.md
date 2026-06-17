# WeChat MiMoCode Bridge - 项目规则

## 项目概述

- 项目名称：wechat-mimocode
- 仓库地址：https://github.com/ch613/WeChat-MiMoCode
- 本地路径：f:\program\wechat-mimocode
- 技术栈：TypeScript + Node.js >= 18
- 作用：通过微信与本地 MiMoCode CLI 对话的桥接

## 强制规则：回答问题前先参考汇总文档

**在回答任何问题前，必须先检查 `.trae/rules/agents-skills-summary.md` 是否与问题相关。如果相关，必须参考该文档内容来回答。**

该文档汇总了本机 Codex CLI 和 OpenCode 的：
- Agent 列表（11 个 OmO agent、角色、默认模型、回退链）
- Skill 列表（Codex 24 个、OpenCode 2 个、OmO 6 个内置）
- 任务类别（8 个，含模型和回退链）
- 模型提供商（8 个，含 baseURL 和可用模型）
- 斜杠命令（8 个 OmO 命令）
- 配置文件路径速查表

### 触发参考的关键词

当用户问题包含以下任何关键词时，必须先查阅汇总文档：
- codex、opencode、omo、oh-my-openagent
- agent、skill、类别、category
- 模型、model、提供商、provider
- 斜杠命令、slash command
- sisyphus、hephaestus、oracle、librarian、explore、prometheus、metis、momus、atlas
- playwright、git-master、frontend-ui-ux、dev-browser
- ralph-loop、start-work、refactor、init-deep

### 执行方式

1. 收到问题后，先判断是否涉及上述关键词
2. 如果涉及，读取 `.trae/rules/agents-skills-summary.md` 获取准确信息
3. 基于文档内容回答，不要凭记忆编造
4. 如果文档中没有相关信息，明确告知用户并建议查阅实际配置文件

## 强制规则：代码修改后必须 git 同步

**对本项目的程序代码进行修改后，必须执行 git 提交并推送到远程仓库。文档修改不需要推送。**

这是项目的约定，目的是保留代码的版本历史，方便后续回退。

### 执行步骤

代码修改完成后，在项目根目录 `f:\program\wechat-mimocode` 执行：

```bash
git add -A
git commit -m "<描述本次修改，使用 Conventional Commits 规范>"
git push origin main
```

### 提交信息规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

- `feat: 新增 xxx 功能`
- `fix: 修复 xxx 问题`
- `docs: 更新 xxx 文档`
- `style: 调整 xxx 格式`
- `refactor: 重构 xxx`
- `chore: 构建/工具变更`

### 触发场景

以下操作完成后，才执行 git 同步（推送）：
- 修改 src/ 下的源码
- 修改 bin/ 或 scripts/ 下的脚本
- 修改 .bat 脚本（install.bat、start.bat）
- 修改配置文件（package.json、tsconfig.json）

以下情况**不需要推送**：
- 修改文档（README.md、SKILL.md、CONTRIBUTING.md、.trae/rules/ 下的 md 文件）
- 修改 .md 类规则文件

### 本地提交即可

对于文档修改，只需 `git add` 和 `git commit` 保存到本地即可，不需要执行 `git push`。等下次有代码修改推送时，这些文档提交会一起被推上去。

## 构建与验证

- 编译：`npm run build`（TypeScript → dist/）
- 开发模式：`npm run dev`（tsc --watch）
- 启动：`npm start` 或 `wechat-mimocode daemon start`
- 验证安装：`wechat-mimocode --version`

## 代码风格

- 使用 TypeScript
- 遵循现有代码风格（2 空格缩进、双引号字符串）
- 模块化导入使用 `.js` 扩展名（ESM 规范）
- 添加必要的注释，但不过度

## 项目结构

```
wechat-mimocode/
├── bin/                    # CLI 入口
├── src/
│   ├── commands/           # 斜杠命令路由与处理
│   ├── mimocode/           # MiMoCode CLI 调用与 Skill 扫描
│   ├── tools/              # 工具函数
│   ├── wechat/             # 微信 API、消息、媒体处理
│   ├── config.ts           # 配置加载
│   ├── constants.ts        # 常量（数据目录、默认模型）
│   ├── daemon.ts           # 守护进程管理
│   ├── logger.ts           # 日志
│   ├── main.ts             # 主入口
│   ├── session.ts          # 会话管理
│   └── store.ts            # 数据存储
├── scripts/                # 辅助脚本
├── install.bat             # 一键安装
├── start.bat               # 启动服务
└── package.json
```
