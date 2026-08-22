/**
 * M11 人机通道分离（D45–D47）：pi 扩展自建 Windows 命名管道。
 *
 *  - 主控（客户端）：一连接一请求（与 herdr 客户端同风格）；
 *  - 子 pane（服务端）：PI_HERDR_SUBAGENT=1 的扩展在 session_start 起 server，
 *    收到 prompt/follow_up 后经 pi.sendUserMessage(followUp) 注入会话本身（TUI 可见）；
 *  - 完成信息不回传（权威路径 = herdr 状态 + 会话 JSONL + history，D47）。
 *
 * 本文件只含传输层纯逻辑（可单测，不依赖 pi API）；
 * pi 注入由 index.ts 的服务端回调完成。
 */
import * as net from 'node:net';
import { sessionDirName } from './session-tail.ts';

/** 管道名：workspace 作用域（与 history.jsonl 目录命名同约定）+ paneId 编码。 */
export function pipeNameFor(cwd: string, paneId: string): string {
  const dir = sessionDirName(cwd);
  const encoded = String(paneId).replace(/[^A-Za-z0-9_-]/g, '-');
  return `pi-herdr-${dir}-${encoded}`;
}

/** Windows 命名管道完整地址（内核命名空间，非文件系统路径）。 */
export function pipePathFor(name: string): string {
  return process.platform === 'win32'
    ? (name.startsWith('\\\\.\\pipe\\') ? name : `\\\\.\\pipe\\${name}`)
    : `/tmp/${name}.sock`;
}

/** 管道消息（JSON 行协议；一连接一请求 = 一个请求一个响应）。 */
export type PipeRequest =
  | { type: 'ping'; id: string }
  | {
      type: 'prompt' | 'follow_up';
      id: string;
      text: string;
      /** 发送方管道名（D49：回复随 from 走；无主从硬编码）。 */
      from?: string | null;
      /** D50：结算时是否 push reply（后台 true、前台 false——前台由调用方同步取结果）。 */
      push?: boolean;
    }
  | { type: 'interrupt'; id: string }
  | {
      /** D50：结算快路径回信（子 → 请求方；带摘要 + 会话路径，渐进式披露）。 */
      type: 'reply';
      id: string;
      paneId: string;
      text: string | null;
      sessionFile: string | null;
    };

export type PipeResponse =
  | { type: 'ok'; id: string; detail?: string }
  | { type: 'error'; id: string; message: string };

/** 解析一行 JSON（坏行返回 null）。 */
export function parsePipeLine(line: string): PipeRequest | PipeResponse | null {
  const t = (line ?? '').trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === 'object' && typeof obj.type === 'string') return obj as PipeRequest | PipeResponse;
  } catch {
    /* 坏行 */
  }
  return null;
}

/**
 * 一连接一请求：连接 → 写一行 JSON → 等一行 JSON 响应 → 断开。
 * 超时/连接失败/坏响应 → 抛错（调用方决定重试）。
 */
export function pipeRequest(
  pipeName: string,
  payload: PipeRequest,
  timeoutMs = 8000,
): Promise<PipeResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(pipePathFor(pipeName));
    sock.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(`pipe ${pipeName}: ${payload.type} timeout`));
      }
    }, timeoutMs);
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      sock.destroy();
      const parsed = parsePipeLine(buf.slice(0, i));
      if (!parsed) {
        reject(new Error(`pipe ${pipeName}: bad response frame`));
        return;
      }
      resolve(parsed);
    });
    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/** 带重试的 ping（就绪探测；D47 取代 waitSubReady 的 agent 状态门）。 */
export async function pingUntilReady(
  pipeName: string,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await pipeRequest(pipeName, { type: 'ping', id: `ping-${Date.now()}` }, 3000);
      if (res.type === 'ok') return true;
    } catch {
      /* 未就绪，继续 */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export type PipeMessageHandler = (req: PipeRequest) => Promise<PipeResponse>;

/**
 * 服务端：每连接读一行 → 分发 handler → 回一行 → 断开。
 * 返回 server 实例（调用方管理 close）。
 */
export function startPipeServer(
  pipeName: string,
  handler: PipeMessageHandler,
): net.Server {
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const req = parsePipeLine(line);
      if (!req) {
        sock.end(JSON.stringify({ type: 'error', id: '', message: 'bad frame' }) + '\n');
        return;
      }
      void handler(req)
        .then((res) => {
          sock.end(JSON.stringify(res) + '\n');
        })
        .catch((err: unknown) => {
          sock.end(JSON.stringify({
            type: 'error',
            id: req.id,
            message: String((err as Error)?.message ?? err),
          }) + '\n');
        });
    });
    sock.on('error', () => {
      /* 客户端断开等：静默 */
    });
  });
  server.on('error', () => {
    /* 地址占用等：由调用方观察（listen 抛错由 startPipeServer 调用方处理） */
  });
  server.listen(pipePathFor(pipeName));
  return server;
}
