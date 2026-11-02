import type { PermissionMode } from './contracts.js';
import { runCommand, type CommandResult } from './workspace-services.js';

/** Acceptance criteria prefixed with this marker are executed as shell commands during Verify. */
export const VERIFY_COMMAND_PREFIX = 'cmd:';

export interface VerificationCheck {
  criterion: string;
  status: 'passed' | 'failed' | 'skipped';
  command?: string;
  exitCode?: number | null;
  output?: string;
  reason?: string;
}

export interface VerificationResult {
  /** True when no check failed. A run with no commands is treated as passed and reports every check as skipped. */
  verified: boolean;
  checks: VerificationCheck[];
}

export interface VerificationOptions {
  workspacePath: string;
  acceptanceCriteria: readonly string[];
  permissionMode: PermissionMode;
  run?: (root: string, command: string) => Promise<CommandResult>;
}

/**
 * Runs each `cmd:` acceptance criterion in the Docker sandbox used for workspace commands. Strict mode refuses
 * to run them. Non-command criteria are reported as skipped.
 */
export async function runVerification(options: VerificationOptions): Promise<VerificationResult> {
  const run = options.run ?? ((root, command) => runCommand(root, command));
  const checks: VerificationCheck[] = [];
  for (const criterion of options.acceptanceCriteria) {
    if (!criterion.startsWith(VERIFY_COMMAND_PREFIX)) {
      checks.push({ criterion, status: 'skipped', reason: 'Not an executable criterion (missing "cmd:" prefix).' });
      continue;
    }
    const command = criterion.slice(VERIFY_COMMAND_PREFIX.length).trim();
    // The criterion is part of the task contract written by the developer, so it is not subject to the
    // read-only standard policy. strict mode still refuses to run commands; execution stays inside Docker.
    if (options.permissionMode === 'strict') {
      checks.push({ criterion, status: 'failed', command, reason: 'Verification commands are not run in strict mode.' });
      continue;
    }
    const result = await run(options.workspacePath, command);
    const passed = result.exitCode === 0 && !result.timedOut;
    checks.push({
      criterion,
      status: passed ? 'passed' : 'failed',
      command,
      exitCode: result.exitCode,
      output: result.output,
      ...(result.timedOut ? { reason: 'Verification command timed out.' } : {}),
    });
  }
  const verified = checks.every((check) => check.status !== 'failed');
  return { verified, checks };
}
