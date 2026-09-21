/**
 * ANSI-aware text measurement and clipping for pier's TUI surfaces.
 *
 * Local implementation: the todo widget, the pinned pane title and the ask_user_question multi-select
 * all need width-correct clipping, but importing `visibleWidth`/`truncateToWidth` from pi-tui would
 * make those paths depend on a package that may be absent in stripped installs. The table below only
 * has to be right for ASCII plus the CJK/emoji ranges that actually appear in user content.
 */

const SGR = /\x1b\[[0-9;]*m/y;

export function charWidth(cp: number): number {
  if (cp < 32) return 0;
  if (cp >= 0x7f && cp < 0xa0) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining marks
  if (
    (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f9ff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Rendered cell width; SGR sequences count as zero cells. */
export function styledWidth(line: string): number {
  let width = 0;
  let i = 0;
  while (i < line.length) {
    SGR.lastIndex = i;
    const m = SGR.exec(line);
    if (m && m.index === i) {
      i += m[0].length;
      continue;
    }
    const cp = line.codePointAt(i)!;
    width += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return width;
}

/** Cut to `width` cells without breaking escape sequences; wide glyphs count as two cells. */
export function truncateStyled(line: string, width: number): string {
  if (width <= 0) return '';
  if (styledWidth(line) <= width) return line;
  const keep = Math.max(0, width - 1); // reserve one cell for the ellipsis
  let out = '';
  let used = 0;
  let i = 0;
  while (i < line.length) {
    SGR.lastIndex = i;
    const m = SGR.exec(line);
    if (m && m.index === i) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const w = charWidth(cp);
    if (used + w > keep) break;
    out += cp > 0xffff ? line.slice(i, i + 2) : line[i]!;
    used += w;
    i += cp > 0xffff ? 2 : 1;
  }
  return `${out}\x1b[0m…`;
}

/**
 * Wrap to `width` cells, preferring space breaks and never splitting a wide glyph or an escape
 * sequence. Open SGR codes are re-emitted at continuation starts so a style spanning the break (a
 * dim description) survives; emitted lines end with a reset when a style is open.
 */
export function wrapStyled(line: string, width: number): string[] {
  if (width <= 0) return [''];
  const out: string[] = [];
  let current = '';
  let used = 0;
  let spaceAt = -1; // index in `current` of the last breakable space
  let open = '';    // SGR codes active at the scan position
  let i = 0;
  while (i < line.length) {
    SGR.lastIndex = i;
    const m = SGR.exec(line);
    if (m && m.index === i) {
      current += m[0];
      open = m[0] === '\x1b[0m' ? '' : open + m[0];
      i += m[0].length;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const w = charWidth(cp);
    const chunk = cp > 0xffff ? line.slice(i, i + 2) : line[i]!;
    if (used + w > width && used > 0) {
      // A space that overflows breaks there; otherwise rewind to the last space so words stay whole.
      const atSpace = chunk === ' ';
      const head = !atSpace && spaceAt > 0 ? current.slice(0, spaceAt) : current;
      const tail = !atSpace && spaceAt > 0 ? current.slice(spaceAt + 1) : '';
      out.push(head.replace(/ +$/, '') + (open ? '\x1b[0m' : ''));
      current = open + tail;
      used = styledWidth(tail);
      const tailSpace = tail.lastIndexOf(' ');
      spaceAt = tailSpace > 0 ? open.length + tailSpace : -1;
      if (atSpace) i += 1; // the breaking space is consumed, not re-processed
      continue; // re-evaluate the pending char on the fresh line
    }
    if (used + w > width) {
      // A glyph wider than the whole line (width 1): emit it alone.
      out.push(current + chunk + (open ? '\x1b[0m' : ''));
      current = open;
      used = 0;
      spaceAt = -1;
      i += cp > 0xffff ? 2 : 1;
      continue;
    }
    current += chunk;
    used += w;
    if (chunk === ' ') spaceAt = current.length - 1;
    i += cp > 0xffff ? 2 : 1;
  }
  if (current || out.length === 0) out.push(current);
  return out;
}
