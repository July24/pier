/** Shared source loader for one-shot hook scripts: prefer the compiled src/<name>.js artifact and
 * fall back to the .ts source only when it is strictly newer (dev edits before a rebuild).
 *
 * Hooks spawn a Node process per herdr event; runtime type-stripping of the .ts sources costs
 * ~150ms per run, so the repo ships tsc-compiled .js artifacts next to the sources (see
 * tsconfig.build.json; `npm test` regenerates them and CI rejects stale artifacts). */
import { statSync } from 'node:fs';

/** Loads `../src/<name>`: the compiled .js when it is at least as fresh as the .ts, else the .ts. */
export async function loadSrc(name) {
  const js = new URL(`../src/${name}.js`, import.meta.url);
  const ts = new URL(`../src/${name}.ts`, import.meta.url);
  try {
    if (statSync(js).mtimeMs >= statSync(ts).mtimeMs) return await import(js);
  } catch {
    /* artifact missing (fresh source-only checkout): the .ts import below is the old path */
  }
  return import(ts);
}
