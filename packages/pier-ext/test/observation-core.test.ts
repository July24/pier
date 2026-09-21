/**
 * D101 ObservationPack Core Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  completeLineExcerpt,
  containsReducerReceipt,
  deriveObservationId,
  formatObservationPlaceholder,
  isObservationId,
  shouldPackForCache,
  sliceBufferChunk,
} from '../src/observation-core.ts';

test('deriveObservationId: deterministic 24-hex ID and handles collisions', () => {
  const hash1 = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const id1 = deriveObservationId('bash', 'call_1', hash1);
  const id2 = deriveObservationId('bash', 'call_1', hash1);
  const id3 = deriveObservationId('bash', 'call_2', hash1);

  assert.equal(id1, id2);
  assert.notEqual(id1, id3); // Different tool call IDs must not collide
  assert.equal(isObservationId(id1), true);
  assert.equal(isObservationId(id3), true);
  assert.equal(isObservationId('invalid_id'), false);
});

test('containsReducerReceipt: identifies EPR receipts to prevent double packing', () => {
  assert.equal(containsReducerReceipt('normal output\n123'), false);
  assert.equal(containsReducerReceipt('header\nsol_pi_evidence_receipt_v1\ndetails'), true);
});

test('completeLineExcerpt: maintains whole line boundaries', () => {
  const text = 'line 1\nline 2\nline 3\nline 4\n';
  // Head excerpt with 15 bytes budget: 'line 1\n' is 7 bytes, 'line 2\n' is 7 bytes (total 14)
  const head = completeLineExcerpt(text, 15, false);
  assert.equal(head, 'line 1\nline 2\n');

  // Tail excerpt with 15 bytes budget: 'line 3\n' + 'line 4\n' is 14 bytes
  const tail = completeLineExcerpt(text, 15, true);
  assert.equal(tail, 'line 3\nline 4\n');
});

test('formatObservationPlaceholder: includes metadata and whole line previews', () => {
  const text = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
  const placeholder = formatObservationPlaceholder({
    id: 'obs_0123456789abcdef01234567',
    toolName: 'bash',
    bytes: 35,
    lines: 5,
    tokens: 9,
    text,
    fullSends: 2,
    excerptBudget: 20,
  });

  assert.ok(placeholder.includes('obs_0123456789abcdef01234567'));
  assert.ok(placeholder.includes('tool: bash'));
  assert.ok(placeholder.includes('original_bytes: 35'));
  assert.ok(placeholder.includes('retrieve: call obs_recall'));
  assert.ok(placeholder.includes('line 1\n'));
});

test('sliceBufferChunk: pages by line limit and reports eof', () => {
  const buf = Buffer.from('Row 1\nRow 2\nRow 3\nRow 4\nRow 5\n', 'utf8');
  const chunk1 = sliceBufferChunk(buf, 0, { maxBytes: 1024, maxLines: 2 });
  assert.deepEqual([chunk1.text, chunk1.lines, chunk1.eof], ['Row 1\nRow 2\n', 2, false]);
  const chunk2 = sliceBufferChunk(buf, chunk1.nextOffset, { maxBytes: 1024, maxLines: 2 });
  assert.deepEqual([chunk2.text, chunk2.lines, chunk2.eof], ['Row 3\nRow 4\n', 2, false]);
  const chunk3 = sliceBufferChunk(buf, chunk2.nextOffset, { maxBytes: 1024, maxLines: 2 });
  assert.deepEqual([chunk3.text, chunk3.lines, chunk3.eof], ['Row 5\n', 1, true]);
  assert.deepEqual(sliceBufferChunk(buf, buf.length, { maxBytes: 1024, maxLines: 2 }), { text: '', bytes: 0, lines: 0, nextOffset: buf.length, eof: true });
});

test('sliceBufferChunk: never splits a multi-byte character at the byte limit', () => {
  // '中' is 3 bytes (E4 B8 AD); a 4-byte budget would cut the second one in half.
  const chunk = sliceBufferChunk(Buffer.from('中中', 'utf8'), 0, { maxBytes: 4, maxLines: 10 });
  assert.equal(chunk.text, '中');
  assert.equal(chunk.bytes, 3);
  assert.equal(chunk.eof, false);
});

test('shouldPackForCache: balances read savings against prefix rewrite cost', () => {
  // Case 1: removedTokens = 5000, remaining = 10 -> Benefit = 50000 tokens
  // tailTokensAfter = 2000, ratio = 12.5 (incremental = 11.5) -> Cost = 23000 tokens
  // 50000 > 23000 -> profitable
  assert.equal(
    shouldPackForCache({
      removedTokens: 5000,
      tailTokensAfter: 2000,
      expectedRemainingRequests: 10,
      cacheWriteReadRatio: 12.5,
    }),
    true,
  );

  // Case 2: removedTokens = 500, remaining = 1 -> Benefit = 500 tokens
  // tailTokensAfter = 10000, incremental = 11.5 -> Cost = 115000 tokens
  // 500 < 115000 -> heavy loss!
  assert.equal(
    shouldPackForCache({
      removedTokens: 500,
      tailTokensAfter: 10000,
      expectedRemainingRequests: 1,
      cacheWriteReadRatio: 12.5,
    }),
    false,
  );

  // Case 3: Free cache writes (ratio = 0 or 1.0)
  assert.equal(
    shouldPackForCache({
      removedTokens: 100,
      tailTokensAfter: 50000,
      expectedRemainingRequests: 1,
      cacheWriteReadRatio: 1.0,
    }),
    true,
  );
});
