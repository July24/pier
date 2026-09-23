/**
 * Shared herdr glue for the workbench hook scripts (one-shot processes, no cordis): socket target
 * and NDJSON request exchange.
 */
import * as net from 'node:net';

/** POSIX socket paths are used verbatim; on win32 a bare pipe name needs the \\.\pipe\ prefix. */
export function socketTarget() {
  const target = process.env.HERDR_SOCKET_PATH;
  if (process.platform !== 'win32' || !target) return target;
  return target.startsWith('\\\\.\\pipe\\') ? target : '\\\\.\\pipe\\' + target;
}

/** One NDJSON round trip on a fresh connection: {id,method,params} -> {id,result} | {id,error}. */
export function request(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const target = socketTarget();
    if (!target) return reject(new Error('no socket path'));
    const sock = net.createConnection(target);
    sock.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(method + ' timeout'));
    }, timeoutMs);
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(value);
    };
    sock.on('connect', () => sock.write(JSON.stringify({ id: '1', method, params }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, i).trim()); } catch { return settle(reject, new Error('bad frame')); }
      if (msg.error) return settle(reject, new Error(`${msg.error.code}: ${msg.error.message}`));
      settle(resolve, msg.result);
    });
    sock.on('error', (err) => settle(reject, err));
  });
}
