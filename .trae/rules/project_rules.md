# WeChat MiMoCode Bridge - 项目规则

## 项目概述

- 项目名称：wechat-mimocode
- 仓库地址：https://github.com/ch613/WeChat-MiMoCode
- 本地路径：f:\program\wechat-mimocode
- 技术栈：TypeScript + Node.js >= 18
- 作用：通过微信与本地 MiMoCode CLI 对话的桥接

## 强制规则：代码修改后必须 git 同步

**每次对本项目代码进行任何修改（新增、编辑、删除文件）后，必须立即执行 git 提交并推送到远程仓库。**

这是项目的硬性约定，目的是保留完整的版本历史，方便后续回退。

### 执行步骤

修改完成后，在项目根目录 `f:\program\wechat-mimocode` 执行：

```bash
git add -A
git commit -m "<描述本次修改，使用 Conventional Commits 规范>"
git push origin main
```

或者直接运行：

```bash
git-sync.bat
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

以下任何操作完成后，都要执行 git 同步：
- 修改 src/ 下的源码
- 修改 bin/ 或 scripts/ 下的脚本
- 修改 .bat 脚本（install.bat、git-sync.bat、start.bat）
- 修改配置文件（package.json、tsconfig.json）
- 修改文档（README.md、SKILL.md、CONTRIBUTING.md）
- 新增或删除任何文件

### 不要跳过

即使是很小的改动（改一行注释、修一个 typo）也要提交。频繁的小提交比一次大提交更利于回退。

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
├── git-sync.bat            # 一键 git 同步
├── start.bat               # 启动服务
└── package.json
```
