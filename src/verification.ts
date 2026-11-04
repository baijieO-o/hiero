import type { PermissionMode } from './contracts.js';
import { classifyFailure, summarizeErrors, type FailureKind } from './error-parser.js';
import { runCommand, type CommandResult } from './workspace-services.js';

/** Acceptance criteria prefixed with this marker are executed as shell commands during Verify. */
export const VERIFY_COMMAND_PREFIX = 'cmd:';

export interface VerificationCheck {
  criterion: string;
  status: 'passed' | 'failed' | 'skipped';
  command?: string;
  exitCode?: number | null;
  output?: string;
  /** Core diagnostics extracted from `output`, for retry prompts. */
  errorSummary?: string;
  /** Failure bucket and corrective guidance, set only for failed commands. */
  failureKind?: FailureKind;
  guidance?: string;
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

function failureDetails(result: CommandResult): Pick<VerificationCheck, 'errorSummary' | 'failureKind' | 'guidance'> {
  const output = result.output ?? '';
  const classification = classifyFailure(output, result.timedOut);
  return { errorSummary: summarizeErrors(output).text, failureKind: classification.kind, guidance: classification.guidance };
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
      ...(passed ? {} : failureDetails(result)),
      ...(result.timedOut ? { reason: 'Verification command timed out.' } : {}),
    });
  }
  const verified = checks.every((check) => check.status !== 'failed');
  return { verified, checks };
}
