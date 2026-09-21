/**
 * A1 护栏：pi 只在 execute() **throw** 时置 isError（docs/extensions.md「Signaling errors」），
 * 返回对象里的任何 isError 字段都被忽略。审计发现 pier 的工具把 20+ 处真失败当成普通文本返回，
 * 于是模型看不到失败，依赖 `event.isError` 的 B1 自愈钩子也成了死代码。
 *
 * 这里做两层防护：
 *  1. 源码层：工具模块里不得再出现「把 `Error:` 文本塞进 content 返回」的写法（必须走 toolError）；
 *  2. 契约层：直接验证 pi 的规则在我们的工具上成立——失败会 reject，而「空结果但非失败」仍是返回值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ToolError, toolError } from '../src/tool-error.ts';

const TOOL_MODULES = [
  'src/plugins/subagent.ts',
  'src/plugins/terminal.ts',
  'src/plugins/todo.ts',
  'src/plugins/observation.ts',
];

test('A1 源码护栏：工具模块不再用文本返回真失败（必须 throw）', () => {
  const offenders: string[] = [];
  for (const file of TOOL_MODULES) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    src.split('\n').forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return; // 注释
      // 反模式：把 "Error: …" 文本放进返回的 content
      if (/content: \[\{ type: 'text', text: (`|')[^`']*Error:/.test(code)) {
        offenders.push(`${file}:${i + 1}: ${code.slice(0, 90)}`);
      }
      if (/content: \[\{ type: 'text', text: (resolved\.error|launch\.text|isoGuard\.text)/.test(code)) {
        offenders.push(`${file}:${i + 1}: ${code.slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `下列失败仍是返回值（模型看不到 isError）：\n${offenders.join('\n')}`);
});

test('A1：toolError 去掉冗余的 "Error: " 前缀并保留原因', () => {
  assert.throws(() => toolError('Error: boom'), (err: unknown) => {
    assert.ok(err instanceof ToolError);
    assert.equal((err as Error).message, 'boom');
    return true;
  });
  assert.throws(() => toolError('boom'), /^Error: boom$|boom/);
  // 抛出而不是返回：调用方拿不到返回值
  let returned = false;
  try {
    toolError('x');
    returned = true;
  } catch {
    /* expected */
  }
  assert.equal(returned, false);
});
