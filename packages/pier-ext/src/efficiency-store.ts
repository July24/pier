/**
 * D101-D103 Efficiency Storage & I/O Adapter.
 *
 * Implements safe, content-addressed storage for ObservationPack and
 * Evidence-Preserving Reducer, along with telemetry log appending and
 * secure bash un-truncated output reading.
 *
 * Security & Integrity:
 *  - Mode 0700 for directories, 0600 for object and log files.
 *  - O_NOFOLLOW to forbid symlinks.
 *  - Safe sessionId regex validation.
 *  - EEXIST integrity verification (rejects corrupted collisions).
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  countLines,
  sha256Hex,
  sliceBufferChunk,
  type RecallSliceResult,
} from './observation-core.ts';

export const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
export const BASH_LOG_NAME_RE = /^pi-bash-.*\.log$/;

const READ_OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_OBJECT_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const verifiedObjectCache = new Set<string>();

export function clearVerifiedObjectCacheForTest(): void {
  verifiedObjectCache.clear();
}

export interface StorageObjectResult {
  path: string;
  bytes: number;
  lines: number;
  hash: string;
}

export function isValidSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.length > 0 && SAFE_SESSION_ID_RE.test(id);
}

export function resolveSessionRoot(
  sessionDir: string | null | undefined,
  sessionId: string | null | undefined,
): string | null {
  if (!sessionDir || typeof sessionDir !== 'string') return null;
  if (!isValidSessionId(sessionId)) return null;
  return join(sessionDir, 'herdr-pi', sessionId!);
}

export function observationObjectPath(root: string, obsId: string): string {
  return join(root, 'observation-pack', 'objects', `${obsId}.txt`);
}

export function reducerObjectPath(root: string, sha256: string): string {
  return join(root, 'evidence-preserving-reducer', 'objects', `${sha256}.txt`);
}

export function efficiencyLogPath(
  root: string,
  mechanism: 'compact' | 'observation' | 'reducer' | 'jev' | 'routing',
  customPath?: string,
): string {
  if (customPath && typeof customPath === 'string') return resolve(customPath);
  return join(root, 'efficiency-logs', `${mechanism}.jsonl`);
}

export const MAX_OBJECTS_PER_DIR = 300;
export const MAX_OBJECTS_TOTAL_BYTES = 50 * 1024 * 1024; // 50MB

export async function pruneObjectsDirectory(
  dir: string,
  limits: { maxFiles?: number; maxTotalBytes?: number } = {},
): Promise<number> {
  const maxFiles = limits.maxFiles ?? MAX_OBJECTS_PER_DIR;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_OBJECTS_TOTAL_BYTES;

  try {
    const entries = await readdir(dir);
    const files: Array<{ name: string; path: string; size: number; mtimeMs: number }> = [];
    let totalBytes = 0;

    for (const name of entries) {
      if (!name.endsWith('.txt')) continue;
      const p = join(dir, name);
      try {
        const s = await stat(p);
        if (s.isFile() && !s.isSymbolicLink()) {
          files.push({ name, path: p, size: s.size, mtimeMs: s.mtimeMs });
          totalBytes += s.size;
        }
      } catch {
        /* ignore stat errors */
      }
    }

    if (files.length <= maxFiles && totalBytes <= maxTotalBytes) {
      return 0;
    }

    // Sort by mtime ascending (oldest first)
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let removedCount = 0;
    for (const f of files) {
      if (files.length - removedCount <= maxFiles && totalBytes <= maxTotalBytes) {
        break;
      }
      try {
        await rm(f.path, { force: true });
        removedCount++;
        totalBytes -= f.size;
        for (const k of verifiedObjectCache.keys()) {
          if (k.startsWith(f.path)) verifiedObjectCache.delete(k);
        }
      } catch {
        /* ignore unlink errors */
      }
    }
    return removedCount;
  } catch {
    return 0;
  }
}

/** Prune both content-addressed object dirs of one session root; returns total removed files. */
export async function pruneSessionObjects(
  sessionRoot: string,
  limits: { maxFiles?: number; maxTotalBytes?: number } = {},
): Promise<number> {
  const targets = [
    join(sessionRoot, 'observation-pack', 'objects'),
    join(sessionRoot, 'evidence-preserving-reducer', 'objects'),
  ];
  let removed = 0;
  for (const dir of targets) {
    removed += await pruneObjectsDirectory(dir, limits);
  }
  return removed;
}

let storeWriteCounter = 0;

export async function storeContentAddressedObject(
  filePath: string,
  content: string,
  precomputed?: { bytes?: number; hash?: string; lines?: number },
): Promise<StorageObjectResult> {
  const contentBytes = precomputed?.bytes ?? Buffer.byteLength(content, 'utf8');
  const hash = precomputed?.hash ?? sha256Hex(content);
  const lines = precomputed?.lines ?? countLines(content);

  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirStats = await lstat(dir);
  if (!dirStats.isDirectory() || dirStats.isSymbolicLink()) {
    throw new Error(`Target directory is not a safe directory: ${dir}`);
  }

  let handle;
  try {
    handle = await open(filePath, CREATE_OBJECT_FLAGS, 0o600);
    await handle.writeFile(content, { encoding: 'utf8' });
    const writtenStat = await handle.stat();
    verifiedObjectCache.add(`${filePath}:${contentBytes}:${writtenStat.mtimeMs}:${hash}`);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      // Verify existing file integrity
      const existingHandle = await open(filePath, READ_OBJECT_FLAGS);
      try {
        const existingStat = await existingHandle.stat();
        if (!existingStat.isFile()) {
          throw new Error(`Existing object is not a regular file: ${filePath}`);
        }
        if (existingStat.size !== contentBytes) {
          throw new Error(`Existing object size mismatch: ${existingStat.size} vs ${contentBytes}`);
        }
        // mtime-aware cache key: prevents reading large files repeatedly if mtime hasn't changed
        const mtimeKey = `${filePath}:${contentBytes}:${existingStat.mtimeMs}:${hash}`;
        if (!verifiedObjectCache.has(mtimeKey)) {
          const existingData = await existingHandle.readFile();
          if (sha256Hex(existingData) !== hash) {
            throw new Error(`Existing object hash mismatch: ${filePath}`);
          }
          verifiedObjectCache.add(mtimeKey);
        }
      } finally {
        await existingHandle.close();
      }
    } else {
      throw err;
    }
  } finally {
    await handle?.close();
  }

  storeWriteCounter++;
  if (storeWriteCounter % 50 === 0) {
    void pruneObjectsDirectory(dir).catch(() => {});
  }

  return {
    path: filePath,
    bytes: contentBytes,
    lines,
    hash,
  };
}

export async function readStoredObjectChunk(
  filePath: string,
  offset: number,
  limits: { maxBytes: number; maxLines: number },
): Promise<RecallSliceResult> {
  let handle;
  try {
    handle = await open(filePath, READ_OBJECT_FLAGS);
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error(`Stored object is not a regular file: ${filePath}`);
    }
    if (offset > fileStat.size) {
      throw new Error(`Offset ${offset} exceeds object size ${fileStat.size}`);
    }

    const available = Math.max(0, fileStat.size - offset);
    const buffer = Buffer.alloc(Math.min(available, limits.maxBytes + 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return sliceBufferChunk(buffer.subarray(0, bytesRead), 0, limits);
  } finally {
    await handle?.close();
  }
}

export const MAX_EFFICIENCY_LOG_BYTES = 5 * 1024 * 1024; // 5MB rotation ceiling

export async function appendEfficiencyLog(
  logPath: string,
  record: Record<string, unknown>,
): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const dir = dirname(logPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // Rotate log if exceeds maximum size to prevent unbounded disk growth
  try {
    const s = await stat(logPath);
    if (s.size > MAX_EFFICIENCY_LOG_BYTES) {
      const oldPath = `${logPath}.old`;
      await rm(oldPath, { force: true });
      await rename(logPath, oldPath);
    }
  } catch {
    /* file may not exist yet, continue */
  }

  let handle;
  try {
    handle = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
    await handle.writeFile(line, { encoding: 'utf8' });
  } finally {
    await handle?.close();
  }
}

/**
 * Safely reads Pi's untruncated bash output from temporary file.
 */
export async function readBashFullOutput(
  rawPath: string | null | undefined,
  maxChars: number,
): Promise<{ content: string; bytes: number; lines: number } | null> {
  if (!rawPath || typeof rawPath !== 'string') return null;

  const fileName = basename(rawPath);
  if (!BASH_LOG_NAME_RE.test(fileName)) return null;

  try {
    const realTmp = await realpath(tmpdir());
    const realFile = await realpath(rawPath);
    const rel = relative(realTmp, realFile);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;

    const fileStat = await stat(realFile);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null;

    // Check size within reasonable limit
    if (fileStat.size > maxChars * 4) return null;

    let handle = await open(realFile, READ_OBJECT_FLAGS);
    try {
      const content = await handle.readFile({ encoding: 'utf8' });
      return {
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        lines: countLines(content),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
