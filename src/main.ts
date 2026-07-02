import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { WeChatApi } from './wechat/api.js';
import { loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl, extractFirstFileItem, downloadFile } from './wechat/media.js';
import { createSessionStore, DEFAULT_SESSION_KEY, type Session } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';
import { runChatService, type ChatServiceInput } from './app/chat-service.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MAX_MESSAGE_LENGTH = 4000;

interface SessionRuntime {
  sessionKey: string;
  session: Session;
}

function getRuntimeControllerKey(accountId: string, sessionKey: string): string {
  return `${accountId}::${sessionKey}`;
}

function parseBlocks(text: string): string[] {
  return text.split(/\n\n+/).filter((block) => block.length > 0);
}

function findSafeSplitPoint(text: string, maxLen: number): number {
  let idx = text.lastIndexOf('\n', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  const sentenceEnd = /[。！？?!?]$/;
  for (let i = maxLen; i >= maxLen * 0.5; i--) {
    if (sentenceEnd.test(text.slice(i - 1, i))) return i;
  }

  idx = text.lastIndexOf(' ', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  return maxLen;
}

function splitByNewline(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    const splitIdx = findSafeSplitPoint(remaining, maxLen);
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }

  return chunks;
}

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const blocks = parseBlocks(text);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    if (current.length === 0) {
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
      }
      continue;
    }

    if (current.length + 2 + block.length <= maxLen) {
      current += `\n\n${block}`;
      continue;
    }

    chunks.push(current);
    if (block.length <= maxLen) {
      current = block;
    } else {
      chunks.push(...splitByNewline(block, maxLen));
      current = '';
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendTextChunks(
  sender: ReturnType<typeof createSender>,
  toUserId: string,
  contextToken: string,
  text: string,
): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await sender.sendText(toUserId, contextToken, chunk);
  }
}

async function sendQueuedNotice(
  sender: ReturnType<typeof createSender>,
  msg: WeixinMessage,
): Promise<void> {
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id) return;

  const text = msg.item_list ? extractTextFromItems(msg.item_list) : '';
  if (text.startsWith('/')) return;

  try {
    await sender.sendText(
      msg.from_user_id,
      msg.context_token ?? '',
      '上一条还在处理中，我已经收到这条消息，处理完会继续回复你。',
    );
  } catch (err) {
    logger.warn('Failed to send queued notice', { error: err instanceof Error ? err.message : String(err) });
  }
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const qrPath = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();
    const isHeadlessLinux = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(qrPath, pngData);
      openFile(qrPath);
      console.log('已打开二维码图片，请用微信扫描。');
      console.log(`图片路径: ${qrPath}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  try {
    unlinkSync(qrPath);
  } catch {
    logger.warn('Failed to clean up QR image', { path: qrPath });
  }

  const workingDir = await promptUser('请输入工作目录', join(homedir(), 'Documents', 'MiMoCode'));
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

function normalizeSession(
  accountId: string,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  config: ReturnType<typeof loadConfig>,
  sessionKey: string = DEFAULT_SESSION_KEY,
): void {
  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(accountId, session, sessionKey);
  }

  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(accountId, session, sessionKey);
  }
}

function replaceRuntimeSession(runtime: SessionRuntime, sessionKey: string, nextSession: Session): Session {
  for (const key of Object.keys(runtime.session) as Array<keyof Session>) {
    delete runtime.session[key];
  }

  Object.assign(runtime.session, nextSession);
  runtime.sessionKey = sessionKey;
  return runtime.session;
}

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  const currentAccount = account;

  const api = new WeChatApi(currentAccount.botToken, currentAccount.baseUrl);
  const sessionStore = createSessionStore();
  const activeSessionKey = sessionStore.getActiveSessionKey(currentAccount.accountId);
  const runtime: SessionRuntime = {
    sessionKey: activeSessionKey,
    session: sessionStore.load(currentAccount.accountId, activeSessionKey),
  };
  normalizeSession(currentAccount.accountId, runtime.session, sessionStore, config, runtime.sessionKey);

  const sender = createSender(api, currentAccount.accountId);
  const activeControllers = new Map<string, AbortController>();
  const messageQueue: WeixinMessage[] = [];
  let processingQueue = false;

  async function drainQueue(): Promise<void> {
    if (processingQueue) return;
    processingQueue = true;
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      await handleMessage(msg, currentAccount, runtime, sessionStore, sender, config, activeControllers);
    }
    processingQueue = false;
  }

  function handlePriorityCommand(msg: WeixinMessage): boolean {
    if (msg.message_type !== MessageType.USER || !msg.item_list) return false;

    const text = extractTextFromItems(msg.item_list);
    if (!text.startsWith('/stop') && !text.startsWith('/clear')) return false;
    if (runtime.session.state !== 'processing') return false;

    const controller = activeControllers.get(getRuntimeControllerKey(currentAccount.accountId, runtime.sessionKey));
    if (controller) {
      controller.abort();
      activeControllers.delete(getRuntimeControllerKey(currentAccount.accountId, runtime.sessionKey));
    }

    runtime.session.state = 'idle';
    sessionStore.save(currentAccount.accountId, runtime.session, runtime.sessionKey);

    if (text.startsWith('/stop')) {
      messageQueue.length = 0;
      sender.sendText(msg.from_user_id!, msg.context_token ?? '', '⏹ 已停止当前对话，排队中的消息已清空。').catch(() => {});
    }

    return true;
  }

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      if (handlePriorityCommand(msg)) return;
      const shouldNotifyQueued = processingQueue || messageQueue.length > 0 || runtime.session.state === 'processing';
      messageQueue.push(msg);
      if (shouldNotifyQueued) {
        logger.info('Message queued while busy', {
          messageId: msg.message_id,
          queueLength: messageQueue.length,
          sessionState: runtime.session.state,
          sessionKey: runtime.sessionKey,
        });
        await sendQueuedNotice(sender, msg);
      }
      void drainQueue();
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  function shutdown(): void {
    logger.info('Shutting down...');
    monitor.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start API server alongside the WeChat monitor
  import('./api/server.js').then(({ startApiServer }) => {
    startApiServer(true);
  }).catch((err) => {
    logger.warn('Failed to start API server', { error: err instanceof Error ? err.message : String(err) });
  });

  logger.info('Daemon started', { accountId: currentAccount.accountId });
  console.log(`已启动（账号: ${currentAccount.accountId}）`);

  await monitor.run();
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  runtime: SessionRuntime,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;
  if (account.userId && msg.from_user_id !== account.userId) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  const userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);
  const fileItem = extractFirstFileItem(msg.item_list);
  const session = runtime.session;

  if (session.state === 'processing' && !userText.startsWith('/')) {
    return;
  }

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session, runtime.sessionKey);
    };

    const switchSession = (sessionKey: string): Session => {
      const nextSession = sessionStore.load(account.accountId, sessionKey);
      normalizeSession(account.accountId, nextSession, sessionStore, config, sessionKey);
      sessionStore.setActiveSessionKey(account.accountId, sessionKey);
      return replaceRuntimeSession(runtime, sessionKey, nextSession);
    };

    const createSession = (sessionKey: string): Session => {
      const nextSession = sessionStore.create(account.accountId, sessionKey, session);
      sessionStore.setActiveSessionKey(account.accountId, sessionKey);
      return replaceRuntimeSession(runtime, sessionKey, nextSession);
    };

    const deleteSession = (sessionKey: string): void => {
      sessionStore.remove(account.accountId, sessionKey);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      sessionKey: runtime.sessionKey,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId, session, runtime.sessionKey),
      listSessions: () => sessionStore.list(account.accountId),
      switchSession,
      createSession,
      deleteSession,
      hasSession: (sessionKey: string) => sessionStore.sessionExists(account.accountId, sessionKey),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      return;
    }

    if (result.handled && result.claudePrompt) {
      await sendToMimoCode(
        result.claudePrompt,
        imageItem,
        fileItem,
        fromUserId,
        contextToken,
        account,
        runtime,
        sessionStore,
        sender,
        config,
        activeControllers,
      );
      return;
    }

    if (result.handled && result.sendFile) {
      await sender.sendFile(fromUserId, contextToken, result.sendFile);
      return;
    }

    if (result.handled) return;
  }

  if (!userText && !imageItem && !fileItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、语音、图片或文件');
    return;
  }

  await sendToMimoCode(
    userText,
    imageItem,
    fileItem,
    fromUserId,
    contextToken,
    account,
    runtime,
    sessionStore,
    sender,
    config,
    activeControllers,
  );
}

async function buildImageInputs(
  imageItem: ReturnType<typeof extractFirstImageUrl>,
): Promise<ChatServiceInput['images']> {
  if (!imageItem) return undefined;

  const base64DataUri = await downloadImage(imageItem);
  if (!base64DataUri) return undefined;

  const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) return undefined;

  return [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: matches[1],
        data: matches[2],
      },
    },
  ];
}

async function sendToMimoCode(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fileItem: ReturnType<typeof extractFirstFileItem>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  runtime: SessionRuntime,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  try {
    const session = runtime.session;
    const images = await buildImageInputs(imageItem);
    const filePath = fileItem ? await downloadFile(fileItem) || undefined : undefined;
    const fileName = fileItem?.file_item?.file_name;

    const result = await runChatService({
      clientId: account.accountId,
      sessionKey: runtime.sessionKey,
      controllerKey: getRuntimeControllerKey(account.accountId, runtime.sessionKey),
      userText,
      session,
      sessionStore,
      config,
      activeControllers,
      images,
      filePath,
      fileName,
      emptyInputLabel: filePath ? '(文件)' : imageItem ? '(图片)' : '(空消息)',
      systemPrompt: '你正在通过微信与用户对话，不是在终端里。不要让用户去终端操作。如果用户需要文件，直接输出文件地址即可，系统会自动识别并推送文件到微信。',
      startActivity: () => sender.startTyping(fromUserId, contextToken),
      onTextChunk: (text) => sendTextChunks(sender, fromUserId, contextToken, text),
      onKeepalive: (text) => sender.sendText(fromUserId, contextToken, text),
      onFile: (path) => sender.sendFile(fromUserId, contextToken, path),
    });

    if (result.aborted) {
      return;
    }

    if (!result.text) {
      if (result.error) {
        logger.error('MiMoCode query error', { error: result.error });
        await sender.sendText(fromUserId, contextToken, 'MiMoCode 处理请求时出错，请稍后重试。');
      } else if (!result.streamed) {
        await sender.sendText(fromUserId, contextToken, 'MiMoCode 无返回内容（可能因权限被拒而终止）');
      }
    } else if (result.error) {
      logger.warn('MiMoCode query had error but returned text, using text', { error: result.error });
    }

    if (result.undeliveredFiles.length > 0) {
      logger.error('File delivery failed after all retries', { files: result.undeliveredFiles });
      await sender.sendText(fromUserId, contextToken, '文件推送失败（服务端限频），请稍后重试。').catch(() => {});
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Error in sendToMimoCode', { error: errorMsg });
    await sender.sendText(fromUserId, contextToken, '处理消息时出错，请稍后重试。');
  }
}

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else if (command === 'daemon') {
  const subCmd = process.argv[3] || 'start';
  import('./daemon.js').then(({ handleDaemon }) => handleDaemon(subCmd)).catch((err) => {
    console.error('daemon 管理错误:', err);
    process.exit(1);
  });
} else if (command === '--version' || command === '-v') {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  console.log(pkg.version);
} else {
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
