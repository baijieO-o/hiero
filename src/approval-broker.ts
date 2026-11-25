import { randomUUID } from 'node:crypto';

export interface ApprovalRequest {
  approval_id: string;
  tool_name: string;
  summary: string;
  input: unknown;
}

export interface ApprovalDecision {
  approved: boolean;
  /** For file edits, the hunk ids the operator accepted. Omitted means every hunk. */
  accepted_hunks?: number[] | undefined;
  /** Set when the request expired without an operator answer, so callers can report it as a timeout. */
  timed_out?: boolean | undefined;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

/** Holds approval requests until the operator answers them or they time out. */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  public constructor(
    private readonly notify: (request: ApprovalRequest) => void,
    private readonly timeoutMs = 120_000,
  ) {}

  public request(toolName: string, summary: string, input: unknown): Promise<ApprovalDecision> {
    const request: ApprovalRequest = { approval_id: randomUUID(), tool_name: toolName, summary, input };
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => this.settle(request.approval_id, { approved: false, timed_out: true }), this.timeoutMs);
      this.pending.set(request.approval_id, { request, resolve, timer });
      this.notify(request);
    });
  }

  /** Returns false when the id is unknown or already settled, so duplicate replies are ignored. */
  public respond(approvalId: string, approved: boolean, acceptedHunks?: number[]): boolean {
    return this.settle(approvalId, acceptedHunks === undefined ? { approved } : { approved, accepted_hunks: acceptedHunks });
  }

  public pendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  private settle(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    entry.resolve(decision);
    return true;
  }
}
