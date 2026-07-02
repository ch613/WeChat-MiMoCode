import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { createBlankSession, createSessionStore, DEFAULT_SESSION_KEY, type Session } from '../session.js';
import { validateAccountId } from '../store.js';
import { runChatService, type ChatServiceInput, type ChatServiceResult } from '../app/chat-service.js';
import { type ToolUseEvent } from '../mimocode/provider.js';
import { isAuthorized } from './auth.js';

interface ChatRequestBody {
  clientId: string;
  conversationId?: string;
  sessionId?: string;
  text?: string;
  cwd?: string;
  model?: string;
  systemPrompt?: string;
  filePath?: string;
  imagePath?: string;
  imagePaths?: string[];
  interrupt?: boolean;
  queue?: boolean;
  waitTimeoutMs?: number;
}

interface OpenAIChatMessagePart {
  type?: string;
  text?: string;
  image_url?: {
    url?: string;
  };
}

interface OpenAIChatMessage {
  role: string;
  content?: string | OpenAIChatMessagePart[] | null;
}

interface OpenAIStreamOptions {
  include_usage?: boolean;
}

interface OpenAIChatCompletionRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  stream_options?: OpenAIStreamOptions;
  user?: string;
  clientId?: string;
  conversationId?: string;
  sessionId?: string;
  cwd?: string;
  systemPrompt?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  response_format?: unknown;
  interrupt?: boolean;
  queue?: boolean;
  waitTimeoutMs?: number;
}

interface OpenAINormalizedRequest extends ChatRequestBody {
  stream: boolean;
  includeUsageInStream: boolean;
  ignoredFields: string[];
  requestedTools?: unknown[];
  toolChoice?: unknown;
}

interface UsageEstimate {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

type SessionStoreApi = ReturnType<typeof createSessionStore>;

interface ApiSessionContext {
  session: Session;
  sessionStore: SessionStoreApi;
  sessionKey?: string;
  controllerKey: string;
  stateful: boolean;
}

interface RequestLogContext {
  requestId: string;
  clientId?: string;
  conversationId?: string;
  mode?: 'stateless' | 'stateful';
  model?: string;
  stream?: boolean;
}

const config = loadConfig();
const sessionStore = createSessionStore();
const activeControllers = new Map<string, AbortController>();
const shouldAnnounceStartup = process.env.WMC_API_QUIET !== '1';
const allowedApiWorkingDirectories = parseAllowedWorkingDirectories();
const apiDefaultWorkingDirectory = resolveApiDefaultWorkingDirectory();
const API_FIRST_FLUSH_LEN = 1;
const API_MIN_BATCH_FLUSH_LEN = 12;
const API_FLUSH_DEBOUNCE_MS = 40;

function isIgnorableStreamError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  return code === 'EPIPE' || code === 'EOF' || code === 'ERR_STREAM_DESTROYED';
}

function isIgnorableWriteException(error: unknown): boolean {
  if (!isIgnorableStreamError(error)) {
    return false;
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const syscall = 'syscall' in error ? String((error as { syscall?: unknown }).syscall ?? '') : '';
  return syscall === '' || syscall === 'write';
}

function attachStreamGuard(stream: NodeJS.WriteStream, name: string): void {
  stream.on('error', (error) => {
    if (isIgnorableStreamError(error)) {
      logger.warn(`Ignoring closed ${name} stream`, {
        code: (error as NodeJS.ErrnoException).code ?? 'unknown',
      });
      return;
    }

    logger.error(`${name} stream error`, {
      error: error instanceof Error ? error.message : String(error),
      code: (error as NodeJS.ErrnoException).code ?? 'unknown',
    });
  });
}

function safeStdoutWrite(line: string): void {
  try {
    process.stdout.write(line, (error?: Error | null) => {
      if (!error || isIgnorableStreamError(error)) {
        return;
      }

      const ioError = error as NodeJS.ErrnoException;

      logger.error('stdout write callback failed', {
        error: error.message,
        code: ioError.code ?? 'unknown',
      });
    });
  } catch (error) {
    if (isIgnorableStreamError(error)) {
      logger.warn('Ignoring synchronous stdout write failure');
      return;
    }

    const ioError = error as NodeJS.ErrnoException;

    logger.error('stdout write threw unexpectedly', {
      error: error instanceof Error ? error.message : String(error),
      code: ioError.code ?? 'unknown',
    });
  }
}

attachStreamGuard(process.stdout, 'stdout');
attachStreamGuard(process.stderr, 'stderr');

process.on('uncaughtException', (error) => {
  if (isIgnorableWriteException(error)) {
    logger.warn('Ignoring uncaught stdio write exception', {
      code: (error as NodeJS.ErrnoException).code ?? 'unknown',
      syscall: (error as NodeJS.ErrnoException).syscall ?? 'unknown',
    });
    return;
  }

  logger.error('Uncaught exception in HTTP API', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body, null, 2));
}

function sendOpenAIError(res: ServerResponse, statusCode: number, message: string, type: string = 'invalid_request_error'): void {
  sendJson(res, statusCode, {
    error: {
      message,
      type,
      param: null,
      code: null,
    },
  });
}

function sendSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendOpenAISseData(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function normalizeFsPath(filePath: string): string {
  const resolved = resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeFsPath(candidatePath);
  const root = normalizeFsPath(rootPath);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function parseAllowedWorkingDirectories(): string[] {
  const raw = process.env.WMC_ALLOWED_CWDS?.trim();
  const entries = raw
    ? raw.split(/[;\n]+/).map((item) => item.trim()).filter(Boolean)
    : [config.workingDirectory];

  return [...new Set(entries.map((item) => resolve(item)))];
}

function resolveApiDefaultWorkingDirectory(): string {
  const raw = process.env.WMC_API_CWD?.trim();
  const candidate = raw || config.workingDirectory || process.cwd();
  return ensureAllowedWorkingDirectory(candidate);
}

function ensureAllowedWorkingDirectory(cwd: string): string {
  const resolved = resolve(cwd);
  if (allowedApiWorkingDirectories.some((root) => isPathInsideRoot(resolved, root))) {
    return resolved;
  }

  throw new Error(`cwd is not allowed: ${resolved}`);
}

function sanitizeSessionWorkingDirectory(clientId: string, session: Session, store: SessionStoreApi, sessionKey?: string): void {
  const currentCwd = session.workingDirectory || config.workingDirectory;
  try {
    session.workingDirectory = ensureAllowedWorkingDirectory(currentCwd);
  } catch {
    logger.warn('Resetting disallowed API session cwd', {
      clientId,
      sessionKey: sessionKey || DEFAULT_SESSION_KEY,
      cwd: currentCwd,
      fallback: config.workingDirectory,
    });
    session.workingDirectory = ensureAllowedWorkingDirectory(config.workingDirectory);
    store.save(clientId, session, sessionKey);
  }
}

function updateRequestLogContext(target: RequestLogContext, body: ChatRequestBody, stream: boolean): void {
  target.clientId = body.clientId;
  target.conversationId = body.conversationId;
  target.mode = body.conversationId?.trim() ? 'stateful' : 'stateless';
  target.model = body.model;
  target.stream = stream;
}

function inferMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

function buildImageInputs(imagePaths: string[]): ChatServiceInput['images'] {
  const validPaths = imagePaths.filter((filePath) => existsSync(filePath));
  if (validPaths.length === 0) {
    return undefined;
  }

  return validPaths.map((filePath) => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: inferMimeType(filePath),
      data: readFileSync(filePath).toString('base64'),
    },
  }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function loadSession(clientId: string, sessionKey: string = DEFAULT_SESSION_KEY): Session {
  const session = sessionStore.load(clientId, sessionKey);

  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(clientId, session, sessionKey);
  }

  const controllerKey = `${clientId}::${sessionKey}`;
  if (session.state !== 'idle' && !activeControllers.has(controllerKey)) {
    logger.warn('Resetting stale session state for API request', { clientId, sessionKey, state: session.state });
    session.state = 'idle';
    sessionStore.save(clientId, session, sessionKey);
  }

  sanitizeSessionWorkingDirectory(clientId, session, sessionStore, sessionKey);

  return session;
}

function createEphemeralSessionStore(): SessionStoreApi {
  return {
    load: () => createBlankSession(),
    save: () => {},
    clear: (_accountId: string, currentSession?: Session) => createBlankSession(currentSession),
    create: (_accountId: string, _sessionKey: string, baseSession?: Session) => createBlankSession(baseSession),
    remove: () => {},
    list: () => [DEFAULT_SESSION_KEY],
    sessionExists: () => false,
    getActiveSessionKey: () => DEFAULT_SESSION_KEY,
    setActiveSessionKey: () => {},
    addChatMessage: sessionStore.addChatMessage,
    getChatHistoryText: sessionStore.getChatHistoryText,
  };
}

function createEphemeralSession(): Session {
  return createBlankSession({
    workingDirectory: apiDefaultWorkingDirectory,
    model: config.model,
  });
}

function createControllerKey(clientId: string, sessionKey?: string): string {
  return sessionKey ? `${clientId}::${sessionKey}` : `${clientId}::stateless::${randomUUID()}`;
}

function resolveApiSessionContext(body: ChatRequestBody): ApiSessionContext {
  if (body.conversationId && body.conversationId.trim()) {
    const sessionKey = body.conversationId.trim();
    return {
      session: loadSession(body.clientId, sessionKey),
      sessionStore,
      sessionKey,
      controllerKey: createControllerKey(body.clientId, sessionKey),
      stateful: true,
    };
  }

  return {
    session: createEphemeralSession(),
    sessionStore: createEphemeralSessionStore(),
    sessionKey: undefined,
    controllerKey: createControllerKey(body.clientId),
    stateful: false,
  };
}

function applySessionOverrides(clientId: string, session: Session, body: ChatRequestBody, store: SessionStoreApi, sessionKey?: string): void {
  if (body.sessionId) {
    session.sdkSessionId = body.sessionId;
  }
  if (body.conversationId) {
    session.previousSdkSessionId = undefined;
  }
  if (body.cwd) {
    session.workingDirectory = ensureAllowedWorkingDirectory(body.cwd);
  }
  if (body.model) {
    session.model = body.model;
  }
  sanitizeSessionWorkingDirectory(clientId, session, store, sessionKey);
  store.save(clientId, session, sessionKey);
}

function validateChatBody(body: unknown): ChatRequestBody {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be a JSON object.');
  }

  const parsed = body as Record<string, unknown>;
  if (typeof parsed.clientId !== 'string' || parsed.clientId.trim() === '') {
    throw new Error('clientId is required.');
  }

  validateAccountId(parsed.clientId);

  const waitTimeoutMs =
    typeof parsed.waitTimeoutMs === 'number' && Number.isFinite(parsed.waitTimeoutMs)
      ? Math.max(0, Math.floor(parsed.waitTimeoutMs))
      : undefined;

  return {
    clientId: parsed.clientId,
    conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : undefined,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
    text: typeof parsed.text === 'string' ? parsed.text : undefined,
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : undefined,
    filePath: typeof parsed.filePath === 'string' ? parsed.filePath : undefined,
    imagePath: typeof parsed.imagePath === 'string' ? parsed.imagePath : undefined,
    imagePaths: Array.isArray(parsed.imagePaths) ? parsed.imagePaths.filter((item): item is string => typeof item === 'string') : undefined,
    interrupt: parsed.interrupt === true,
    queue: parsed.queue === true,
    waitTimeoutMs,
  };
}

function normalizeLocalImageRef(url: string): string {
  if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith('/')) {
    return url;
  }

  if (url.startsWith('file://')) {
    const normalized = decodeURIComponent(url.replace(/^file:\/\//i, ''));
    if (/^\/[A-Za-z]:/.test(normalized)) {
      return normalized.slice(1);
    }
    return normalized;
  }

  throw new Error(`Unsupported image_url: ${url}. Only local paths or file:// URLs are supported.`);
}

function extractMessageTextContent(content: OpenAIChatMessage['content'], imagePaths: string[]): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      textParts.push(part.text);
      continue;
    }

    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
      imagePaths.push(normalizeLocalImageRef(part.image_url.url));
    }
  }

  return textParts.join('\n');
}

function formatConversationLine(role: string, content: string): string {
  const roleName =
    role === 'assistant' ? 'Assistant'
      : role === 'tool' ? 'Tool'
        : role === 'developer' ? 'Developer'
          : 'User';

  return `${roleName}: ${content}`;
}

function normalizeOpenAIRequest(body: unknown): OpenAINormalizedRequest {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be a JSON object.');
  }

  const parsed = body as Record<string, unknown>;
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    throw new Error('messages must be a non-empty array.');
  }

  const request = parsed as unknown as OpenAIChatCompletionRequest;
  const clientIdRaw =
    typeof request.clientId === 'string' ? request.clientId
      : typeof request.user === 'string' && request.user.trim() ? request.user
        : 'openai-client';
  validateAccountId(clientIdRaw);

  const systemPrompts: string[] = [];
  const conversationLines: string[] = [];
  const imagePaths: string[] = [];

  for (const message of request.messages) {
    if (!message || typeof message.role !== 'string') {
      throw new Error('Each message must include a role.');
    }

    const contentText = extractMessageTextContent(message.content, imagePaths).trim();
    if (message.role === 'system' || message.role === 'developer') {
      if (contentText) {
        systemPrompts.push(contentText);
      }
      continue;
    }

    if (contentText) {
      conversationLines.push(formatConversationLine(message.role, contentText));
    }
  }

  if (conversationLines.length === 0) {
    throw new Error('At least one non-system message with text content is required.');
  }

  const ignoredFields: string[] = [];
  if (typeof request.temperature === 'number') ignoredFields.push('temperature');
  if (typeof request.max_tokens === 'number') ignoredFields.push('max_tokens');
  if (typeof request.max_completion_tokens === 'number') ignoredFields.push('max_completion_tokens');
  if (typeof request.presence_penalty === 'number') ignoredFields.push('presence_penalty');
  if (typeof request.frequency_penalty === 'number') ignoredFields.push('frequency_penalty');
  if (request.response_format !== undefined) ignoredFields.push('response_format');
  const waitTimeoutMs =
    typeof request.waitTimeoutMs === 'number' && Number.isFinite(request.waitTimeoutMs)
      ? Math.max(0, Math.floor(request.waitTimeoutMs))
      : undefined;

  return {
    clientId: clientIdRaw,
    conversationId: typeof request.conversationId === 'string' ? request.conversationId : undefined,
    sessionId: typeof request.sessionId === 'string' ? request.sessionId : undefined,
    text: conversationLines.join('\n\n'),
    cwd: typeof request.cwd === 'string' ? request.cwd : undefined,
    model: typeof request.model === 'string' ? request.model : undefined,
    systemPrompt: [typeof request.systemPrompt === 'string' ? request.systemPrompt : undefined, ...systemPrompts].filter(Boolean).join('\n\n'),
    imagePaths,
    stream: Boolean(request.stream),
    includeUsageInStream: Boolean(request.stream_options?.include_usage),
    ignoredFields,
    requestedTools: Array.isArray(request.tools) ? request.tools : undefined,
    toolChoice: request.tool_choice,
    interrupt: request.interrupt === true,
    queue: request.queue === true,
    waitTimeoutMs,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSessionAvailable(
  clientId: string,
  sessionKey: string,
  controllerKey: string,
  queue?: boolean,
  waitTimeoutMs?: number,
  interrupt?: boolean,
): Promise<Session> {
  const session = loadSession(clientId, sessionKey);
  if (session.state !== 'processing') {
    return session;
  }

  const controller = activeControllers.get(controllerKey);
  if (!interrupt || !controller) {
    if (!queue) {
      throw new Error('Session is already processing another request.');
    }

    const timeoutMs = waitTimeoutMs ?? 60_000;
    logger.info('Queueing API request behind active session', { clientId, sessionKey, timeoutMs });

    const startedAt = Date.now();
    for (let attempt = 0; attempt < 600; attempt++) {
      await sleep(100);
      const refreshed = loadSession(clientId, sessionKey);
      if (refreshed.state !== 'processing') {
        return refreshed;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for the active request to finish after ${timeoutMs}ms.`);
      }
    }

    throw new Error('Timed out waiting for the active request to finish.');
  }

  logger.warn('Interrupting active session for new API request', { clientId, sessionKey });
  controller.abort();

  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(100);
    const refreshed = loadSession(clientId, sessionKey);
    if (refreshed.state !== 'processing') {
      return refreshed;
    }
  }

  throw new Error('Previous request is still shutting down. Please retry in a moment.');
}

function estimateTokenCount(text: string | undefined): number {
  if (!text) {
    return 0;
  }

  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  const cjkMatches = normalized.match(/[\u3400-\u9FFF]/g) || [];
  const cjkCount = cjkMatches.length;
  const stripped = normalized.replace(/[\u3400-\u9FFF]/g, ' ');
  const words = stripped.match(/[A-Za-z0-9_]+|[^\s]/g) || [];
  return cjkCount + words.length;
}

function estimateUsage(body: ChatRequestBody, resultText: string): UsageEstimate {
  const promptTokens =
    estimateTokenCount(body.systemPrompt)
    + estimateTokenCount(body.text)
    + estimateTokenCount(body.filePath)
    + (body.imagePath ? 50 : 0)
    + ((body.imagePaths?.length || 0) * 50);
  const completionTokens = estimateTokenCount(resultText);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function listAvailableModelIds(): string[] {
  const ids = new Set<string>();
  ids.add(config.model || 'mimo-auto');
  ids.add('mimo-auto');
  if (process.env.WMC_MODEL) {
    ids.add(process.env.WMC_MODEL);
  }
  return [...ids].filter(Boolean);
}

function buildModelInfo(id: string): Record<string, unknown> {
  return {
    id,
    object: 'model',
    created: 0,
    owned_by: 'mimocode',
  };
}

function buildMimoMetadata(result: ChatServiceResult, ignoredFields: string[]): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    session_id: result.sessionId,
    files: result.files,
    undelivered_files: result.undeliveredFiles,
    tool_uses: result.toolUses.map((toolUse: ToolUseEvent) => ({
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
    })),
  };

  if (ignoredFields.length > 0) {
    metadata.ignored_openai_fields = ignoredFields;
  }

  return metadata;
}

function makeChatCompletionId(): string {
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createOpenAICompletionResponse(
  id: string,
  created: number,
  model: string,
  body: ChatRequestBody,
  result: ChatServiceResult,
  ignoredFields: string[],
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.text,
        },
        finish_reason: 'stop',
      },
    ],
    usage: estimateUsage(body, result.text),
    mimocode: buildMimoMetadata(result, ignoredFields),
  };
}

async function executeChat(body: ChatRequestBody): Promise<ChatServiceResult> {
  const context = resolveApiSessionContext(body);
  const session = context.stateful
    ? await ensureSessionAvailable(body.clientId, context.sessionKey!, context.controllerKey, body.queue, body.waitTimeoutMs, body.interrupt)
    : context.session;

  applySessionOverrides(body.clientId, session, body, context.sessionStore, context.sessionKey);

  const imagePaths = [
    ...(body.imagePath ? [body.imagePath] : []),
    ...(body.imagePaths ?? []),
  ];

  return runChatService({
    clientId: body.clientId,
    sessionKey: context.sessionKey,
    controllerKey: context.controllerKey,
    userText: body.text || '',
    session,
    sessionStore: context.sessionStore,
    config,
    activeControllers,
    images: buildImageInputs(imagePaths),
    filePath: body.filePath,
    systemPrompt: body.systemPrompt,
  });
}

async function handleChat(body: ChatRequestBody): Promise<ChatServiceResult> {
  return executeChat(body);
}

async function handleChatStream(body: ChatRequestBody, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const context = resolveApiSessionContext(body);
  let session: Session = context.session;
  if (context.stateful) {
    if (body.queue && context.session.state === 'processing') {
      sendSseEvent(res, 'status', { status: 'queued' });
    }
    try {
      session = await ensureSessionAvailable(body.clientId, context.sessionKey!, context.controllerKey, body.queue, body.waitTimeoutMs, body.interrupt);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Session is already processing another request.';
      sendSseEvent(res, 'error', { message: errorMsg });
      sendSseEvent(res, 'done', { ok: false });
      res.end();
      return;
    }
  }

  applySessionOverrides(body.clientId, session, body, context.sessionStore, context.sessionKey);

  const imagePaths = [
    ...(body.imagePath ? [body.imagePath] : []),
    ...(body.imagePaths ?? []),
  ];

  const result = await runChatService({
    clientId: body.clientId,
    sessionKey: context.sessionKey,
    controllerKey: context.controllerKey,
    userText: body.text || '',
    session,
    sessionStore: context.sessionStore,
    config,
    activeControllers,
    images: buildImageInputs(imagePaths),
    filePath: body.filePath,
    systemPrompt: body.systemPrompt,
    firstFlushLen: API_FIRST_FLUSH_LEN,
    minBatchFlushLen: API_MIN_BATCH_FLUSH_LEN,
    flushDebounceMs: API_FLUSH_DEBOUNCE_MS,
    onStatus: (status) => sendSseEvent(res, 'status', { status }),
    onTextChunk: (text) => sendSseEvent(res, 'text', { text }),
    onFile: (filePath) => sendSseEvent(res, 'file', { filePath }),
  });

  if (result.error && !result.text) {
    sendSseEvent(res, 'error', { message: result.error });
  }

  sendSseEvent(res, 'done', {
    ok: !result.error || !!result.text,
    sessionId: result.sessionId,
    files: result.files,
    undeliveredFiles: result.undeliveredFiles,
    toolUses: result.toolUses,
    aborted: result.aborted,
  });
  res.end();
}

async function handleOpenAIChat(body: OpenAINormalizedRequest, res: ServerResponse): Promise<void> {
  const completionId = makeChatCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const modelName = body.model || config.model || 'mimo-auto';

  if (!body.stream) {
    const result = await executeChat(body);
    if (result.error && !result.text) {
      sendOpenAIError(res, 500, result.error, 'server_error');
      return;
    }

    sendJson(res, 200, createOpenAICompletionResponse(completionId, created, modelName, body, result, body.ignoredFields));
    return;
  }

  const context = resolveApiSessionContext(body);
  let session: Session = context.session;
  if (context.stateful) {
    try {
      session = await ensureSessionAvailable(body.clientId, context.sessionKey!, context.controllerKey, body.queue, body.waitTimeoutMs, body.interrupt);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Session is already processing another request.';
      sendOpenAIError(res, 409, errorMsg, 'conflict_error');
      return;
    }
  }

  applySessionOverrides(body.clientId, session, body, context.sessionStore, context.sessionKey);
  const imagePaths = [
    ...(body.imagePath ? [body.imagePath] : []),
    ...(body.imagePaths ?? []),
  ];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  sendOpenAISseData(res, {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model: modelName,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
        },
        finish_reason: null,
      },
    ],
  });

  const result = await runChatService({
    clientId: body.clientId,
    sessionKey: context.sessionKey,
    controllerKey: context.controllerKey,
    userText: body.text || '',
    session,
    sessionStore: context.sessionStore,
    config,
    activeControllers,
    images: buildImageInputs(imagePaths),
    filePath: body.filePath,
    systemPrompt: body.systemPrompt,
    firstFlushLen: API_FIRST_FLUSH_LEN,
    minBatchFlushLen: API_MIN_BATCH_FLUSH_LEN,
    flushDebounceMs: API_FLUSH_DEBOUNCE_MS,
    onTextChunk: (text) => {
      sendOpenAISseData(res, {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            delta: {
              content: text,
            },
            finish_reason: null,
          },
        ],
      });
    },
  });

  if (result.error && !result.text) {
    sendOpenAISseData(res, {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
      error: {
        message: result.error,
        type: 'server_error',
      },
    });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (body.includeUsageInStream) {
    sendOpenAISseData(res, {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [],
      usage: estimateUsage(body, result.text),
      mimocode: buildMimoMetadata(result, body.ignoredFields),
    });
  }

  sendOpenAISseData(res, {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model: modelName,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ],
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

const host = process.env.WMC_API_HOST || '127.0.0.1';
const port = Number(process.env.WMC_API_PORT || '3080');

const requestHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async (req, res) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const requestLogContext: RequestLogContext = { requestId };
  let responseLogged = false;

  res.setHeader('x-request-id', requestId);

  const logResponse = (event: 'finish' | 'close'): void => {
    if (responseLogged) {
      return;
    }
    responseLogged = true;
    logger.info('HTTP API request completed', {
      requestId,
      event,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      activeSessions: activeControllers.size,
      clientId: requestLogContext.clientId,
      conversationId: requestLogContext.conversationId,
      mode: requestLogContext.mode,
      model: requestLogContext.model,
      stream: requestLogContext.stream,
    });
  };

  res.once('finish', () => logResponse('finish'));
  res.once('close', () => logResponse('close'));

  logger.info('HTTP API request started', {
    requestId,
    method: req.method,
    url: req.url,
    remoteAddress: req.socket.remoteAddress,
    activeSessions: activeControllers.size,
  });

  try {
    if (!req.url || !req.method) {
      sendJson(res, 400, { ok: false, error: 'Invalid request.' });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    const pathname = url.pathname;

    if (!isAuthorized(req)) {
      if (pathname.startsWith('/v1/')) {
        sendOpenAIError(res, 401, 'Unauthorized.', 'authentication_error');
      } else {
        sendJson(res, 401, { ok: false, error: 'Unauthorized.' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/session/clear') {
      const body = validateChatBody(await readJsonBody(req));
      updateRequestLogContext(requestLogContext, body, false);
      if (body.conversationId?.trim()) {
        const sessionKey = body.conversationId.trim();
        const controllerKey = createControllerKey(body.clientId, sessionKey);
        sessionStore.clear(body.clientId, undefined, sessionKey);
        activeControllers.get(controllerKey)?.abort();
        activeControllers.delete(controllerKey);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = validateChatBody(await readJsonBody(req));
      updateRequestLogContext(requestLogContext, body, false);
      const result = await handleChat(body);
      sendJson(res, result.error && !result.text ? 500 : 200, {
        ok: !result.error || !!result.text,
        sessionId: result.sessionId,
        text: result.text,
        files: result.files,
        undeliveredFiles: result.undeliveredFiles,
        toolUses: result.toolUses,
        aborted: result.aborted,
        error: result.error,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/chat/stream') {
      const body = validateChatBody(await readJsonBody(req));
      updateRequestLogContext(requestLogContext, body, true);
      await handleChatStream(body, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: listAvailableModelIds().map((id) => buildModelInfo(id)),
      });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/v1/models/')) {
      const modelId = decodeURIComponent(pathname.slice('/v1/models/'.length));
      const availableModels = listAvailableModelIds();
      if (!availableModels.includes(modelId)) {
        sendOpenAIError(res, 404, `The model '${modelId}' does not exist.`, 'invalid_request_error');
        return;
      }
      sendJson(res, 200, buildModelInfo(modelId));
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      const body = normalizeOpenAIRequest(await readJsonBody(req));
      updateRequestLogContext(requestLogContext, body, body.stream);
      await handleOpenAIChat(body, res);
      return;
    }

    if (pathname.startsWith('/v1/')) {
      sendOpenAIError(res, 404, 'Not found.', 'invalid_request_error');
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found.' });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('API server request failed', {
      requestId,
      error: errorMsg,
      method: req.method,
      url: req.url,
      clientId: requestLogContext.clientId,
      conversationId: requestLogContext.conversationId,
      mode: requestLogContext.mode,
      model: requestLogContext.model,
      stream: requestLogContext.stream,
    });
    if (req.url?.startsWith('/v1/')) {
      sendOpenAIError(res, 400, errorMsg, 'invalid_request_error');
      return;
    }
    sendJson(res, 400, { ok: false, error: errorMsg });
  }
};

export function startApiServer(quiet: boolean = false): void {
  const server = createServer(requestHandler);

  server.on('connection', (socket) => {
    socket.setNoDelay(true);
    socket.on('error', () => {
    });
  });

  server.on('clientError', (err, socket) => {
    const ioError = err as NodeJS.ErrnoException;
    logger.warn('HTTP client error', { error: ioError.code || err.message });
    if (socket.destroyed || socket.writableEnded) {
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.on('error', (err) => {
    const ioError = err as NodeJS.ErrnoException;
    logger.error('HTTP API server error', { error: ioError.code || err.message });
    process.exit(1);
  });

  server.listen(port, host, () => {
    logger.info('HTTP API server started', { host, port, defaultCwd: apiDefaultWorkingDirectory, allowedCwds: allowedApiWorkingDirectories });
    if (!quiet) {
      safeStdoutWrite(`HTTP API listening on http://${host}:${port}\n`);
      safeStdoutWrite(`OpenAI compatible endpoint: http://${host}:${port}/v1/chat/completions\n`);
      safeStdoutWrite(`Default API cwd: ${apiDefaultWorkingDirectory}\n`);
      if (process.env.WMC_API_KEY) {
        safeStdoutWrite(`API Key: ${process.env.WMC_API_KEY}\n`);
      }
    }
  });
}

// Auto-start when run directly via `node dist/api/server.js` (start:api mode)
// When imported as a module, startApiServer() is called explicitly by the importer.
const thisFilePath = fileURLToPath(import.meta.url);
const isDirectRun = resolve(process.argv[1] ?? '') === thisFilePath;

if (isDirectRun) {
  startApiServer();
}
