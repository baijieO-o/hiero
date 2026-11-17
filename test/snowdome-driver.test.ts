import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveDriverPath } from '../src/snowdome-driver.js';

const root = 'C:\\Users\\x\\.hiero\\drivers';

test('driver names resolve only to bare files inside the drivers directory', () => {
  assert.match(resolveDriverPath('planner.mjs', root), /planner\.mjs$/);
  for (const bad of ['', '..\\evil.mjs', '../evil.mjs', 'sub/x.mjs', 'sub\\x.mjs', 'C:\\evil.mjs', '/etc/x.mjs', '..']) {
    assert.throws(() => resolveDriverPath(bad, root), Error, bad);
  }
});
