import { error, type ErrorRecord } from './contracts.js';

export enum AgentState {
  Plan = 'Plan',
  Exec = 'Exec',
  Verify = 'Verify',
  Handoff = 'Handoff',
  Rewind = 'Rewind',
}

const transitions: Record<AgentState, readonly AgentState[]> = {
  [AgentState.Plan]: [AgentState.Exec, AgentState.Handoff],
  [AgentState.Exec]: [AgentState.Verify, AgentState.Handoff, AgentState.Rewind],
  [AgentState.Verify]: [AgentState.Plan, AgentState.Handoff, AgentState.Rewind],
  [AgentState.Handoff]: [AgentState.Plan],
  [AgentState.Rewind]: [AgentState.Plan],
};

export interface StateTransition {
  from: AgentState;
  to: AgentState;
  at: string;
}

export class AgentStateMachine {
  private current: AgentState = AgentState.Plan;
  private readonly history: StateTransition[] = [];

  public get state(): AgentState {
    return this.current;
  }

  public get transitions(): readonly StateTransition[] {
    return this.history;
  }

  public transition(to: AgentState, verified = false): StateTransition {
    if (!transitions[this.current].includes(to)) {
      throw error('ORG-003', 'blocker', `Invalid transition ${this.current} -> ${to}.`, 'Follow the explicit state graph.');
    }
    if (this.current === AgentState.Verify && to === AgentState.Plan && !verified) {
      throw error('ORG-002', 'blocker', 'Verification is required before starting the next plan.', 'Provide a successful verification result.');
    }
    const transition = { from: this.current, to, at: new Date().toISOString() };
    this.current = to;
    this.history.push(transition);
    return transition;
  }

  public assertHealthy(): void {
    if (this.current === AgentState.Exec) {
      throw error('ORG-001', 'warning', 'Execution is still in progress.', 'Complete verification before advancing.');
    }
  }

  public toErrorRecord(exception: unknown): ErrorRecord {
    if (exception instanceof Error && 'record' in exception) {
      return (exception as Error & { record: ErrorRecord }).record;
    }
    return error('ORG-005', 'blocker', exception instanceof Error ? exception.message : String(exception), 'Inspect the state machine event log.').record;
  }
}
