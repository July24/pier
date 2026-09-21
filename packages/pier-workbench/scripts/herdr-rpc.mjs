/**
 * Shared herdr glue for the workbench hook scripts (one-shot processes, no cordis): socket target,
 * NDJSON request exchange, boot-config/boot-record paths, envelope id lookup, launch command.
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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

/**
 * boot-config.json (pi node/cli paths, tab label, hmr flag) comes from HERDR_PLUGIN_CONFIG_DIR in
 * user mode — the herdr-managed checkout is replaced on reinstall — and from the script directory in
 * dev/link mode. Null when neither candidate parses.
 */
export function readBootConfig(scriptDir) {
  const candidates = [
    process.env.HERDR_PLUGIN_CONFIG_DIR ? path.join(process.env.HERDR_PLUGIN_CONFIG_DIR, 'boot-config.json') : null,
    path.join(scriptDir, 'boot-config.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* try next candidate */ }
  }
  return null;
}

/** Boot record log: bootstrap.mjs appends, restore-layout.mjs replays (HERDR_PLUGIN_STATE_DIR is not injected). */
export function bootFilePath() {
  return path.join(os.homedir(), '.pi', 'agent', 'herdr-pi', 'boot.jsonl');
}

/** First string field named `key` anywhere in a herdr envelope (id positions vary per event shape). */
export function deepFind(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (typeof obj[key] === 'string') return obj[key];
  for (const value of Object.values(obj)) {
    const found = deepFind(value, key, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Master pi launch argv (D97: fullscreen by default; PI_HERDR_TUI=regular is the escape hatch). */
export function masterArgv(config) {
  const argv = [config.piNode, config.piCli];
  if (process.env.PI_HERDR_TUI !== 'regular') argv.push('--tui-mode', 'fullscreen');
  argv.push('-e', config.extPath);
  return argv;
}

/** Raw argv -> platform shell line: win32 PowerShell (`&` + '' doubling), POSIX sh (single quotes). */
export function launchCommand(argv) {
  const quote = (s) => (process.platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`);
  return (process.platform === 'win32' ? '& ' : '') + argv.map(quote).join(' ');
}
