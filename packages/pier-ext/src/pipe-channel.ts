/**
 * M11 separates the human/machine channels (D45–D47) by having the pi extension create its own
 * Windows named pipe.
 *
 *  - Controller (client): one connection per request, matching the herdr client;
 *  - Child pane (server): when PI_HERDR_SUBAGENT=1, the extension starts a server at session_start
 *    and injects prompt/follow_up through pi.sendUserMessage (visible in TUI);
 *  - Completion data is not sent back; authoritative state lives in herdr, session JSONL, and
 *    history (D47).
 *
 * Only pure transport-layer logic here; index.ts performs pi injection in the server callback.
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import { sessionDirCandidates, sessionDirName } from './storage-layout.ts';

function encodePaneId(paneId: string): string {
  return String(paneId).replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Pipe name: workspace-scoped (same encoding as history dirs) + paneId. */
export function pipeNameFor(cwd: string, paneId: string): string {
  return `pi-herdr-${sessionDirName(cwd)}-${encodePaneId(paneId)}`;
}

/** New encoding first, then legacy — client retries so mixed-version peers still connect. */
export function pipeNameCandidates(cwd: string, paneId: string): string[] {
  return sessionDirCandidates(cwd).map((dir) => `pi-herdr-${dir}-${encodePaneId(paneId)}`);
}

/** Windows named-pipe address in the kernel namespace, not a filesystem path. */
export function pipePathFor(name: string): string {
  return process.platform === 'win32'
    ? (name.startsWith('\\\\.\\pipe\\') ? name : `\\\\.\\pipe\\${name}`)
    : `/tmp/${name}.sock`;
}

/** Pipe message in the JSON-lines protocol; one connection carries one request and response. */
export type PipeRequest =
  | { type: 'ping'; id: string }
  | {
      type: 'prompt' | 'follow_up';
      id: string;
      text: string;
      /** D49: reply follows the sender's pipe name, avoiding hard-coded controller/child roles. */
      from?: string | null;
      /** D50: whether settlement pushes a reply (background true, foreground false because the caller reads synchronously). */
      push?: boolean;
      /** B3: deliver follow_up as steer so it arrives between tool calls within seconds. Missing/false keeps
       * queue semantics (delivered when the run ends); the initial prompt stays queued while continuations steer. */
      steer?: boolean;
    }
  | { type: 'interrupt'; id: string }
  | {
      /** P0 (RFC §4.4): master switches a worker's role; the worker applies the manifest swap and
       * replies ok/error. Mixed-version peers answer `unknown type role`, which the master surfaces. */
      type: 'role';
      id: string;
      role: string;
    }
  | {
      /** D50: fast-path settlement reply from child to requester, with summary and session path for progressive disclosure. */
      type: 'reply';
      id: string;
      paneId: string;
      text: string | null;
      sessionFile: string | null;
    };

export type PipeResponse =
  | { type: 'ok'; id: string; detail?: string }
  | { type: 'error'; id: string; message: string };

/** Response side of the protocol (`ok` / `error`): requests never use these tags, so this is a sound
 * discriminator when narrowing a parsed line at the answering end. */
function isPipeResponse(value: PipeRequest | PipeResponse): value is PipeResponse {
  return value.type === 'ok' || value.type === 'error';
}

function parsePipeLine(line: string): PipeRequest | PipeResponse | null {
  const t = (line ?? '').trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === 'object' && typeof obj.type === 'string') return obj as PipeRequest | PipeResponse;
  } catch {
  }
  return null;
}

/** One connection, one request: connect → write JSON line → wait for JSON line → close. Timeout /
 * connect failure / bad frame throw (caller retries). */
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
      if (!parsed || !isPipeResponse(parsed)) {
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
    sock.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`pipe ${pipeName}: connection closed`));
      }
    });
  });
}

export async function pipeRequestTo(
  cwd: string,
  paneId: string,
  payload: PipeRequest,
  timeoutMs = 8000,
): Promise<PipeResponse> {
  const names = pipeNameCandidates(cwd, paneId);
  let lastErr: unknown;
  for (const name of names) {
    try {
      return await pipeRequest(name, payload, timeoutMs);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`pipe ${names[0] ?? paneId}: unreachable`);
}

type PipeMessageHandler = (req: PipeRequest) => Promise<PipeResponse>;

/** Server: one line in → handler → one line out → close. Returns the server (caller closes it). */
export function startPipeServer(
  pipeName: string,
  handler: PipeMessageHandler,
  onError?: (err: Error) => void,
): net.Server {
  const socketPath = pipePathFor(pipeName);
  // POSIX leaves the UNIX domain socket behind after a crash, and the next listen fails with
  // EADDRINUSE unless it is unlinked before bind (Windows named pipes need no unlink). Best-effort:
  // if unlink fails, listen reports the real error through onError.
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* see above: listen surfaces the actionable error */
    }
  }
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const parsedLine = parsePipeLine(line);
      if (!parsedLine || isPipeResponse(parsedLine)) {
        sock.end(JSON.stringify({ type: 'error', id: '', message: 'bad frame' }) + '\n');
        return;
      }
      const req: PipeRequest = parsedLine;
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
      /* client disconnect: silent */
    });
  });
  if (onError) {
    server.on('error', onError);
  } else {
    // Always attach a listener: an EventEmitter 'error' with no listener throws and would take the
    // whole extension host down on a transient listen failure; pass onError to observe it (F04).
    server.on('error', () => { /* swallowed by design; pass onError to observe */ });
  }
  if (process.platform !== 'win32') {
    server.on('close', () => {
      try {
        fs.unlinkSync(socketPath);
      } catch {
      }
    });
  }
  server.listen(socketPath);
  return server;
}
