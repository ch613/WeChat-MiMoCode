import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DATA_DIR } from './constants.js';

const PROJECT_DIR = process.cwd();
const LOG_DIR = join(DATA_DIR, 'logs');
const PID_FILE = join(DATA_DIR, 'mimocode-bridge.pid');
const PLATFORM = process.platform;

const AUTOSTART_REG_KEY = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_REG_VALUE = 'WeChatMiMoCode';
const AUTOSTART_VBS_NAME = 'wechat-mimocode-autostart.vbs';

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
}

function readPid(): number | null {
  try {
    const content = readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function writePid(pid: number): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid), 'utf-8');
}

function removePid(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    if (PLATFORM === 'win32') {
      const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8' });
      return output.includes(String(pid));
    }

    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getNodeBin(): string {
  return process.execPath;
}

function getMainJs(): string {
  return join(PROJECT_DIR, 'dist', 'main.js');
}

function getBridgeProcessPids(): number[] {
  const mainJs = getMainJs();

  try {
    if (PLATFORM === 'win32') {
      const escapedMainJs = mainJs.replace(/'/g, "''");
      const filterExpr = `Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^node(.exe)?$' -and $_.ProcessId -ne ${process.pid} -and $_.CommandLine -match $pattern -and $_.CommandLine -match '\\sstart(\\s|$)' -and $_.CommandLine -notmatch '\\sdaemon(\\s|$)' } | Select-Object -ExpandProperty ProcessId`;
      const script = [
        `$pattern = [Regex]::Escape('${escapedMainJs}')`,
        filterExpr,
      ].join('; ');

      const output = execSync(`powershell -NoProfile -Command "${script}"`, { encoding: 'utf-8' });
      return output
        .split(/\r?\n/)
        .map((line) => parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid));
    }

    const output = execSync('ps -ax -o pid= -o command=', { encoding: 'utf-8' });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        const pid = parseInt(match[1], 10);
        const command = match[2];
        if (
          pid !== process.pid
          && command.includes(mainJs)
          && /\sstart(?:\s|$)/.test(command)
          && !/\sdaemon(?:\s|$)/.test(command)
        ) {
          return pid;
        }
        return null;
      })
      .filter((pid): pid is number => pid !== null);
  } catch {
    return [];
  }
}

function uniquePids(pids: Array<number | null | undefined>): number[] {
  return [...new Set(pids.filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0))];
}

function terminatePid(pid: number): void {
  if (!isProcessRunning(pid)) {
    return;
  }

  if (PLATFORM === 'win32') {
    execSync(`taskkill /PID ${pid} /F`);
    return;
  }

  process.kill(pid, 'SIGTERM');
}

function stopBridgeProcesses(): number[] {
  const pids = uniquePids([readPid(), ...getBridgeProcessPids()]);
  const stopped: number[] = [];

  for (const pid of pids) {
    try {
      terminatePid(pid);
      stopped.push(pid);
    } catch {
      // ignore individual failures, we still attempt the rest
    }
  }

  removePid();
  return stopped;
}

function daemonStart(): void {
  ensureLogDir();

  const runningPids = uniquePids([readPid(), ...getBridgeProcessPids()]).filter((pid) => isProcessRunning(pid));
  if (runningPids.length > 0) {
    console.log(`检测到旧的 bridge 实例，正在清理: ${runningPids.join(', ')}`);
    stopBridgeProcesses();
  }

  const nodeBin = getNodeBin();
  const mainJs = getMainJs();
  const stdoutPath = join(LOG_DIR, 'stdout.log');

  console.log('正在启动 wechat-mimocode 守护进程...');

  const child = spawn(nodeBin, [mainJs, 'start'], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
    env: { ...process.env },
    windowsHide: true,
  });

  child.unref();
  writePid(child.pid!);

  console.log(`已启动 (PID: ${child.pid})`);
  console.log(`日志: ${stdoutPath}`);
}

function daemonStop(): void {
  const stoppedPids = stopBridgeProcesses();
  if (stoppedPids.length === 0) {
    console.log('未运行（没有可停止的 bridge 进程）');
    return;
  }

  console.log(`已停止 bridge 进程: ${stoppedPids.join(', ')}`);
}

function daemonStatus(): void {
  const pids = uniquePids([readPid(), ...getBridgeProcessPids()]).filter((pid) => isProcessRunning(pid));
  if (pids.length === 0) {
    console.log('未运行');
    removePid();
    return;
  }

  console.log(`运行中 (${pids.length} 个实例): ${pids.join(', ')}`);
}

function daemonRestart(): void {
  daemonStop();
  setTimeout(() => daemonStart(), 1000);
}

function daemonLogs(): void {
  if (!existsSync(LOG_DIR)) {
    console.log('未找到日志');
    return;
  }

  for (const fileName of ['stdout.log', 'stderr.log']) {
    const filePath = join(LOG_DIR, fileName);
    if (!existsSync(filePath)) {
      continue;
    }

    console.log(`=== ${fileName} (最后 50 行) ===`);
    try {
      const content = readFileSync(filePath, 'utf-8');
      console.log(content.split('\n').slice(-50).join('\n'));
    } catch {
      console.log('(无法读取)');
    }
    console.log('');
  }
}

function getAutostartVbsPath(): string {
  return join(DATA_DIR, AUTOSTART_VBS_NAME);
}

function createAutostartVbs(): string {
  const nodeBin = getNodeBin();
  const mainJs = getMainJs();
  const vbsPath = getAutostartVbsPath();

  // VBS script that launches node silently (no console window)
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${nodeBin}"" ""${mainJs}"" start", 0, False
`;

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(vbsPath, vbsContent, 'utf-8');
  return vbsPath;
}

function autostartEnable(): void {
  if (PLATFORM !== 'win32') {
    console.log('开机自启动目前仅支持 Windows');
    return;
  }

  const vbsPath = createAutostartVbs();
  const regValue = `wscript "${vbsPath}"`;

  try {
    execSync(`reg add "${AUTOSTART_REG_KEY}" /v "${AUTOSTART_REG_VALUE}" /t REG_SZ /d "${regValue}" /f`, { encoding: 'utf-8' });
    console.log('已启用开机自启动');
  } catch (err) {
    console.error('启用开机自启动失败:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function autostartDisable(): void {
  if (PLATFORM !== 'win32') {
    console.log('开机自启动目前仅支持 Windows');
    return;
  }

  try {
    execSync(`reg delete "${AUTOSTART_REG_KEY}" /v "${AUTOSTART_REG_VALUE}" /f`, { encoding: 'utf-8' });
  } catch {
    // Key may not exist, that's fine
  }

  const vbsPath = getAutostartVbsPath();
  try {
    unlinkSync(vbsPath);
  } catch {
    // ignore
  }

  console.log('已禁用开机自启动');
}

function autostartStatus(): void {
  if (PLATFORM !== 'win32') {
    console.log('开机自启动目前仅支持 Windows');
    return;
  }

  try {
    const output = execSync(`reg query "${AUTOSTART_REG_KEY}" /v "${AUTOSTART_REG_VALUE}"`, { encoding: 'utf-8' });
    if (output.includes(AUTOSTART_REG_VALUE)) {
      console.log('开机自启动: 已启用');
      const match = output.match(/REG_SZ\s+(.+)/);
      if (match) {
        console.log(`启动命令: ${match[1].trim()}`);
      }
      return;
    }
  } catch {
    // Key doesn't exist
  }

  console.log('开机自启动: 未启用');
}

export function handleDaemon(command: string): void {
  switch (command) {
    case 'start':
      daemonStart();
      break;
    case 'stop':
      daemonStop();
      break;
    case 'restart':
      daemonRestart();
      break;
    case 'status':
      daemonStatus();
      break;
    case 'logs':
      daemonLogs();
      break;
    case 'autostart':
      autostartEnable();
      break;
    case 'autostart-off':
      autostartDisable();
      break;
    case 'autostart-status':
      autostartStatus();
      break;
    default:
      console.log('用法: wechat-mimocode daemon {start|stop|restart|status|logs|autostart|autostart-off|autostart-status}');
      console.log(`平台: ${PLATFORM}`);
      process.exit(1);
  }
}
