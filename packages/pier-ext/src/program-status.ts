/**
 * OSC 7501 (Program Status Protocol) encoder for the one report pier writes itself: pi 1.4 reports
 * `blocked` for its select/input/editor dialogs but not for `ui.custom`, which pier's ask dialog uses
 * (RFC docs/rfc-core-app-migration.md §5). Everything else is left to pi's native reporter.
 * Grammar: `ESC ] 7501 ; key=value(:key=value)* ESC \`; `msg` is base64; control characters in the
 * message make terminals drop the report, so they are replaced.
 */
const MAX_MESSAGE_BYTES = 2048;

export type PierProgramState = 'blocked' | 'working' | 'idle';

export function formatProgramStatus(state: PierProgramState, message?: string | null): string {
  const pairs = [`state=${state}`, 'app=pi'];
  if (state === 'blocked') pairs.push('kind=question');
  let text = (message ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  while (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) text = text.slice(0, -1);
  if (text) pairs.push(`msg=${Buffer.from(text, 'utf8').toString('base64')}`);
  return `\x1b]7501;${pairs.join(':')}\x1b\\`;
}
