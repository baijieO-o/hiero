import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SystemStatsSampler } from '../src/system-stats.js';

test('SystemStatsSampler reports percentages within 0-100', async () => {
  const sampler = new SystemStatsSampler();
  const first = await sampler.sample();
  const second = await sampler.sample();
  for (const stats of [first, second]) {
    assert.ok(stats.cpuPercent >= 0 && stats.cpuPercent <= 100, `cpu ${stats.cpuPercent}`);
    assert.ok(stats.memPercent >= 0 && stats.memPercent <= 100, `mem ${stats.memPercent}`);
    assert.ok(stats.gpuPercent === null || (stats.gpuPercent >= 0 && stats.gpuPercent <= 100));
  }
});
