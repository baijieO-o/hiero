#!/usr/bin/env node
import { cp, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const templateDir = join(here, 'template');
const target = process.cwd();
const npmCli = process.env.npm_execpath;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (await exists(join(target, 'package.json'))) {
  console.error('Found an existing package.json here. Run create-hiero in an empty folder to avoid overwriting files.');
  process.exit(1);
}

console.log(`Copying the Hiero template into ${target} ...`);
await cp(templateDir, target, { recursive: true, errorOnExist: false, force: false });
console.log(`Created ${(await readdir(target)).length} top-level entries.`);

const steps = [
  { args: ['install'], label: 'backend dependencies (npm install)' },
  { args: ['install', '--prefix', 'frontend'], label: 'frontend dependencies (npm install --prefix frontend)' },
];
for (const step of steps) {
  console.log(`Installing ${step.label}. This may take a few minutes...`);
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...step.args], { cwd: target, stdio: 'inherit' })
    : spawnSync('npm', step.args, { cwd: target, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`Failed to install ${step.label}. Run "npm ${step.args.join(' ')}" manually in this folder.`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nHiero project is ready. To start:');
console.log('  Windows: double-click launch-hiero.bat');
console.log('  Other:   npm start (backend) and npm run dev (frontend)');
