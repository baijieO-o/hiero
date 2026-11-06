import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dockerRunArgs } from '../src/workspace-services.js';

test('workspace bind mount is writable while the root filesystem stays read-only', () => {
  const args = dockerRunArgs('/host/project', '/workspace', 'npm test');
  const mount = args[args.indexOf('--mount') + 1];
  assert.equal(mount, 'type=bind,source=/host/project,target=/workspace');
  assert.equal(mount.includes('readonly'), false);
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--network'));
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('--cap-drop=ALL'));
});

test('command runs through sh -lc inside the requested working directory', () => {
  const args = dockerRunArgs('/host/project', '/workspace/pkg', 'echo hi');
  assert.equal(args[args.indexOf('--workdir') + 1], '/workspace/pkg');
  assert.deepEqual(args.slice(-3), ['sh', '-lc', 'echo hi']);
});
