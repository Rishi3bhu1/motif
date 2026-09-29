import crypto from 'node:crypto';
import {
  readToolOutcome,
  type DecisionExperience,
  type DecisionEvidence,
  type MotifMessage,
} from '@motif/core';

export const fingerprint = (value: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const EXTRACTOR = 'command_recovery/v1' as const;

function command(m: MotifMessage, project: string) {
  if (!['Bash', 'exec_command', 'shell_command', 'shell'].includes(m.toolName ?? '')) return undefined;
  if (!m.toolInput || typeof m.toolInput !== 'object') return undefined;
  const args = m.toolInput as Record<string, unknown>;
  let cmd = args.cmd ?? args.command;
  if (
    Array.isArray(cmd) &&
    cmd.length === 3 &&
    ['bash', 'sh', 'zsh'].includes(String(cmd[0])) &&
    ['-c', '-lc'].includes(String(cmd[1]))
  )
    cmd = cmd[2];
  if (typeof cmd !== 'string' || cmd.length > 2000 || /[;&|><`$\n\r]/.test(cmd)) return undefined;
  // Deliberately small command grammar: no pipelines, substitutions, background
  // jobs or utilities where a nonzero exit commonly means an ordinary answer.
  const text = cmd.trim();
  if (
    !/^(?:npm (?:test|run [\w:-]+)|npx vitest run|cargo (?:test|check|build)|(?:node|python3?) [\w./-]+)(?: [\w./:=@+-]+)*$/.test(
      text,
    )
  )
    return undefined;
  return { text, family: text.split(' ')[0]!, cwd: String(args.workdir ?? args.cwd ?? project) };
}

function exitCode(m: MotifMessage): number | undefined {
  const result = m.toolResult ?? readToolOutcome(m.text);
  if (result?.terminal !== true || !Number.isSafeInteger(result.exitCode)) return undefined;
  return result.exitCode;
}

export interface ExtractionSummary {
  toolCalls: number;
  observedFailures: number;
  candidates: number;
  excluded: Record<string, number>;
}

export function extractRecovery(
  messages: MotifMessage[],
  source: {
    sessionId: string;
    source: string;
    project: string;
    identity: string;
    copied: boolean;
    parseErrors: number;
  },
): { decisions: DecisionExperience[]; summary: ExtractionSummary } {
  const decisions: DecisionExperience[] = [];
  const summary: ExtractionSummary = { toolCalls: 0, observedFailures: 0, candidates: 0, excluded: {} };
  const skip = (reason: string) => {
    summary.excluded[reason] = (summary.excluded[reason] ?? 0) + 1;
  };
  if (
    source.copied ||
    messages.some((m) => m.text?.startsWith('[Handed off') || m.text?.startsWith('[Condensed history'))
  ) {
    skip('copied-history');
    return { decisions, summary };
  }
  if (source.parseErrors > 0) {
    skip('parse-errors');
    return { decisions, summary };
  }
  if (source.source === 'cursor') {
    skip('unsupported-source');
    return { decisions, summary };
  }
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  const sourceFingerprint = fingerprint(messages);
  messages.forEach((m, i) => {
    if (m.role === 'tool_call') summary.toolCalls++;
    if (!m.toolCallId) return;
    const map = m.role === 'tool_call' ? calls : m.role === 'tool_result' ? results : undefined;
    if (map) map.set(m.toolCallId, [...(map.get(m.toolCallId) ?? []), i]);
  });
  const pair = (index: number): number | undefined => {
    const id = messages[index]!.toolCallId;
    if (!id || calls.get(id)?.length !== 1 || results.get(id)?.length !== 1) return undefined;
    const end = results.get(id)![0]!;
    if (
      end <= index ||
      messages.slice(index + 1, end).some((m) => m.role === 'tool_call' || m.role === 'user')
    )
      return undefined;
    // A prior outstanding call would also make the decision context ambiguous.
    for (const [callId, starts] of calls) {
      if (callId === id || starts[0]! >= index) continue;
      const ends = results.get(callId);
      if (ends?.length !== 1 || ends[0]! >= index) return undefined;
    }
    return end;
  };
  const evidence = (seq: number, role: DecisionEvidence['role']): DecisionEvidence => ({
    messageId: messages[seq]!.id,
    seq,
    hash: fingerprint(messages[seq]),
    role,
  });
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role !== 'tool_call') continue;
    const first = command(messages[i]!, source.project);
    if (!first) {
      skip('unsupported-command');
      continue;
    }
    const failureIndex = pair(i);
    if (failureIndex === undefined) {
      skip('ambiguous-or-missing-result');
      continue;
    }
    const failure = messages[failureIndex]!;
    const failedCode = exitCode(failure);
    if (failedCode === undefined) {
      skip('unknown-exit');
      continue;
    }
    if (failedCode <= 0) continue;
    summary.observedFailures++;
    let next = failureIndex + 1;
    while (next < messages.length && messages[next]!.role === 'assistant') next++;
    // Do not use post-failure commentary (which may announce the choice) as input.
    if (messages[next]?.role !== 'tool_call') {
      skip('no-direct-recovery');
      continue;
    }
    const action = command(messages[next]!, source.project);
    if (!action || action.family !== first.family || action.cwd !== first.cwd) {
      skip('unrelated-next-action');
      continue;
    }
    const end = pair(next);
    const code = end === undefined ? undefined : exitCode(messages[end]!);
    const reasons: string[] = [];
    if (code === undefined) reasons.push('unknown-recovery-outcome');
    if (JSON.stringify(messages.slice(i, end === undefined ? next + 1 : end + 1)).includes('[REDACTED]'))
      reasons.push('redacted-evidence');
    const refs = [
      evidence(i, 'failure-call'),
      evidence(failureIndex, 'failure-result'),
      evidence(next, 'action'),
    ];
    if (end !== undefined) refs.push(evidence(end, 'outcome'));
    const decision: DecisionExperience = {
      id: fingerprint([source.identity, messages[next]!.id, EXTRACTOR]),
      input: {
        category: 'command_recovery',
        state: {
          failedCommand: first.text,
          failureExitCode: failedCode,
          failureText: (failure.text ?? '').slice(0, 2000),
        },
        choices: ['retry_unchanged', 'revise_command'],
        choicesOrigin: 'recipe-defined',
      },
      observedChoice: action.text === first.text ? 'retry_unchanged' : 'revise_command',
      action: { command: action.text, messageId: messages[next]!.id },
      outcome: code === undefined ? null : { exitCode: code, success: code === 0, basis: 'source-reported' },
      provenance: {
        sessionId: source.sessionId,
        source: source.source,
        sourceFingerprint,
        cutoffMessageId: failure.id,
        evidence: refs,
        extractor: EXTRACTOR,
      },
      quality: { eligible: reasons.length === 0, reasons, policy: 'recovery/v1' },
    };
    decisions.push(decision);
  }
  summary.candidates = decisions.length;
  return { decisions, summary };
}
