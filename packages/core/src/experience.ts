/** Learning inputs deliberately exclude outcomes and post-decision context. */
export type RecoveryChoice = 'retry_unchanged' | 'revise_command';
export interface DecisionInput {
  category: 'command_recovery';
  state: { failedCommand: string; failureExitCode: number; failureText: string };
  choices: RecoveryChoice[];
  choicesOrigin: 'recipe-defined';
}
export interface DecisionEvidence {
  messageId: string;
  seq: number;
  hash: string;
  role: 'failure-call' | 'failure-result' | 'action' | 'outcome';
}
export interface DecisionExperience {
  id: string;
  input: DecisionInput;
  observedChoice: RecoveryChoice;
  action: { command: string; messageId: string };
  outcome: { exitCode: number; success: boolean; basis: 'source-reported' } | null;
  provenance: {
    sessionId: string;
    source: string;
    sourceFingerprint: string;
    cutoffMessageId: string;
    evidence: DecisionEvidence[];
    extractor: 'command_recovery/v1';
  };
  quality: { eligible: boolean; reasons: string[]; policy: 'recovery/v1' };
  /** Session-level context, not an inferred label on this action. */
  feedback?: {
    relation: 'source-session';
    noteId: number;
    status: string;
    verification: string;
    reviews: { id: number; verdict: string; reason: string | null; created_at: string }[];
    actions: { id: number; status: string; resolution: string | null }[];
  }[];
}
export interface DecisionExample {
  id: string;
  input: DecisionInput;
  target: { choice: RecoveryChoice; basis: 'observed-behavior' };
  experience: DecisionExperience;
  group: string;
  split: 'train' | 'test';
}
export interface DecisionDataset {
  manifest: {
    schema: 'motif-decisions/v1';
    category: 'command_recovery';
    purpose: 'imitation';
    scope: 'team' | 'personal';
    extractor: 'command_recovery/v1';
    qualityPolicy: 'recovery/v1';
    splitPolicy: 'group-hash/v1';
    candidates: number;
    excluded: Record<string, number>;
    examples: number;
    groups: number;
    datasetHash: string;
  };
  examples: DecisionExample[];
}
export interface DecisionPrediction {
  id: string;
  choice?: RecoveryChoice;
  abstain?: boolean;
}
export interface DecisionModel {
  readonly id: string;
  predict(input: DecisionInput): Promise<{ choice: RecoveryChoice } | { abstain: true }>;
}
