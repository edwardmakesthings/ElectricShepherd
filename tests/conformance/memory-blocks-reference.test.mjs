import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const refPath = path.resolve(__dirname, '../../docs/memory-blocks.reference.md');

test('memory blocks reference: required labeled block headers exist in order', async () => {
  const content = await readFile(refPath, 'utf8');
  const required = ['## [project-state]', '## [active-conventions]', '## [user-preferences]'];
  let lastIndex = -1;
  for (const header of required) {
    const idx = content.indexOf(header);
    assert.ok(idx !== -1, `missing required block header: ${header}`);
    assert.ok(idx > lastIndex, `block header out of order: ${header} (expected after index ${lastIndex})`);
    lastIndex = idx;
  }
});

test('memory blocks reference: file does not contain [pending]', async () => {
  const content = await readFile(refPath, 'utf8');
  assert.ok(!content.includes('[pending]'), 'reference file must not contain [pending]');
});
