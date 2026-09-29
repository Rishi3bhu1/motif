import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexSession, readClaudeSession, type MotifSession, type DecisionDataset } from '@motif/core';
import {
  createServer,
  registerMember,
  fullReplaceSession,
  extractDecisions,
  listDecisions,
  exportDataset,
  evaluateDataset,
  validateDataset,
  datasetHash,
  applyNotes,
  applyVerdict,
  type MotifServer,
} from '@motif/server';
import { extractRecovery } from '../packages/server/src/learning/extract.js';

let tmp: string;
let server: MotifServer;
let member: ReturnType<typeof registerMember>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-learning-test-'));
  server = createServer({ dbPath: path.join(tmp, 'db.sqlite') });
  member = registerMember(server.db, { name: 'ada' });
});
afterEach(() => {
  server.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Hand-written native envelopes, never captured agent history. */
function trace(id: string, change = false, outcome = 0): MotifSession {
  const command = `node check-${id}.js`;
  const rows = [
    { type: 'session_meta', payload: { id, cwd: '/workspace/app' } },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'a',
        arguments: JSON.stringify({ cmd: command }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'a',
        output: JSON.stringify({ output: `Failure ${id}`, metadata: { exit_code: 1 } }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'POST-DECISION choice announcement must not become a feature.' },
        ],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'b',
        arguments: JSON.stringify({ cmd: change ? `${command} --strict` : command }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'b',
        output: JSON.stringify({ output: 'FUTURE outcome text', metadata: { exit_code: outcome } }),
      },
    },
  ];
  const file = path.join(tmp, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    rows
      .map((row, ordinal) => JSON.stringify({ ...row, ordinal, timestamp: '2026-01-01T10:00:00.000Z' }))
      .join('\n'),
  );
  return { ...readCodexSession(file), visibility: 'team' };
}
const scope = () => ({ viewerId: member.memberId, scope: 'team' as const });
function seed(n = 8) {
  for (let i = 0; i < n; i++)
    fullReplaceSession(server.db, member.memberId, trace(`s${i}`, i % 2 === 1, i % 3 ? 0 : 1));
  return extractDecisions(server.db, scope());
}

describe('experience learning', () => {
  it('preserves native result evidence and retains tool errors separately', () => {
    const s = trace('receipt');
    expect(s.messages[1]!.toolResult).toEqual({ exitCode: 1, terminal: true });
    const claude = readClaudeSession(path.join(process.cwd(), 'fixtures/claude-code/tools.jsonl'));
    expect(claude.messages.find((m) => m.role === 'tool_result')!.toolResult).toEqual({ isError: false });
  });

  it('extracts through authenticated native ingestion, with input cut off before the decision', async () => {
    const session = trace('native', true, 1);
    const response = await server.app.request(`/api/sessions/${session.id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${member.memberToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(session),
    });
    expect(response.status).toBe(200);
    const result = extractDecisions(server.db, scope());
    expect(result.items).toHaveLength(1);
    const d = result.items[0]!;
    expect(d.observedChoice).toBe('revise_command');
    expect(d.outcome).toMatchObject({ exitCode: 1, success: false });
    expect(d.quality.eligible).toBe(true); // failure is valid evidence, not a bad label
    expect(JSON.stringify(d.input)).not.toMatch(/POST-DECISION|FUTURE|strict/);
    expect(d.provenance.evidence.map((e) => e.role)).toEqual([
      'failure-call',
      'failure-result',
      'action',
      'outcome',
    ]);
    expect(extractDecisions(server.db, scope()).items).toEqual(result.items);
  });

  it('does not infer success from prose and keeps unknown outcomes inspectable', () => {
    const s = trace('unknown');
    s.messages.at(-1)!.toolResult = undefined;
    s.messages.at(-1)!.text = 'Everything passed!';
    fullReplaceSession(server.db, member.memberId, s);
    const result = extractDecisions(server.db, scope());
    expect(result.items[0]!.outcome).toBeNull();
    expect(result.items[0]!.quality.reasons).toContain('unknown-recovery-outcome');
    expect(() => exportDataset(server.db, scope())).toThrow('No eligible');
  });

  it('excludes ambiguous, copied, redacted and unsupported evidence', () => {
    const s = trace('ambiguous');
    const context = {
      sessionId: s.id,
      source: s.source,
      project: s.projectPath,
      identity: 'fixture',
      copied: false,
      parseErrors: 0,
    };
    const parallel = [...s.messages];
    parallel.splice(1, 0, {
      id: 'parallel',
      role: 'tool_call',
      timestamp: '',
      toolCallId: 'other',
      toolName: 'Read',
      toolInput: { file_path: '/workspace/app/a.ts' },
    });
    expect(extractRecovery(parallel, context).decisions).toHaveLength(0);
    expect(extractRecovery(s.messages, { ...context, copied: true }).summary.excluded).toHaveProperty(
      'copied-history',
    );
    expect(extractRecovery(s.messages, { ...context, source: 'cursor' }).summary.excluded).toHaveProperty(
      'unsupported-source',
    );
    s.messages[1]!.text = '[REDACTED]';
    expect(extractRecovery(s.messages, context).decisions[0]!.quality.reasons).toContain('redacted-evidence');
  });

  it('invalidates projections on replacement and source deletion', () => {
    const s = trace('replace');
    fullReplaceSession(server.db, member.memberId, s);
    extractDecisions(server.db, scope());
    s.messages[0]!.toolInput = { cmd: 'node replacement.js' };
    fullReplaceSession(server.db, member.memberId, s);
    expect(listDecisions(server.db, scope()).needsExtraction).toBe(1);
    expect(listDecisions(server.db, scope()).items).toHaveLength(0);
    expect(() => exportDataset(server.db, scope())).toThrow('Sources changed');
    extractDecisions(server.db, scope());
    server.db.prepare('DELETE FROM sessions').run();
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM decision_events').get()).toEqual({ n: 0 });
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM decision_evidence').get()).toEqual({ n: 0 });
  });

  it('rechecks later human rulings and supersession without inventing action labels', () => {
    fullReplaceSession(server.db, member.memberId, trace('review'));
    extractDecisions(server.db, scope());
    const pk = (server.db.prepare('SELECT pk FROM sessions').get() as { pk: number }).pk;
    applyNotes(
      server.db,
      [
        {
          entity: { kind: 'decision', name: 'recovery policy' },
          aspect: 'retry',
          body: 'A source claim awaiting evidence.',
        },
      ],
      { projectPath: '/workspace/app', sessionPk: pk, memberId: member.memberId },
    );
    const id = (server.db.prepare('SELECT id FROM memory_notes').get() as { id: number }).id;
    applyVerdict(server.db, { noteId: id, reviewerId: member.memberId, verdict: 'dispute' });
    expect(listDecisions(server.db, scope()).items[0]!.quality.reasons).toContain(
      `source-memory-needs-review:${id}`,
    );
    applyVerdict(server.db, { noteId: id, reviewerId: member.memberId, verdict: 'confirm' });
    expect(listDecisions(server.db, scope()).eligible).toBe(1);
  });

  it('keeps personal sources out of team counts, inspection and export', async () => {
    const other = registerMember(server.db, { name: 'ben' });
    fullReplaceSession(server.db, member.memberId, { ...trace('private'), visibility: 'personal' });
    const personal = { viewerId: member.memberId, scope: 'personal' as const };
    const id = extractDecisions(server.db, personal).items[0]!.id;
    expect(listDecisions(server.db, scope()).sessions).toBe(0);
    expect(listDecisions(server.db, { viewerId: other.memberId, scope: 'personal' }).sessions).toBe(0);
    const response = await server.app.request(`/api/decisions/${id}?scope=personal`, {
      headers: { authorization: `Bearer ${other.memberToken}` },
    });
    expect(response.status).toBe(404);
    const team = await server.app.request('/api/decisions', {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(team.status).toBe(403);
    expect(exportDataset(server.db, personal).manifest.scope).toBe('personal');
  });

  it('exports reproducibly, groups duplicates and evaluates a training-only baseline', () => {
    seed();
    const dataset = exportDataset(server.db, scope());
    expect(exportDataset(server.db, scope())).toEqual(dataset);
    validateDataset(dataset);
    const report = evaluateDataset(dataset);
    expect(report.train + report.test).toBe(8);
    expect(report.targetBasis).toBe('observed-behavior');
    const test = dataset.examples.filter((e) => e.split === 'test');
    expect(
      evaluateDataset(dataset, {
        datasetHash: dataset.manifest.datasetHash,
        predictions: test.map((e) => ({ id: e.id, choice: e.target.choice })),
      }).accuracy,
    ).toBe(1);
    const abstain = evaluateDataset(dataset, {
      datasetHash: dataset.manifest.datasetHash,
      predictions: test.map((e) => ({ id: e.id, abstain: true })),
    });
    expect(abstain.coverage).toBe(0);
    expect(abstain.abstained).toBe(test.length);
    expect(() => evaluateDataset(dataset, { datasetHash: 'wrong', predictions: [] })).toThrow('hash');
  });

  it('rechecks source privacy for existing decisions and authenticated dataset exports', async () => {
    seed();
    const headers = { authorization: `Bearer ${member.memberToken}`, 'content-type': 'application/json' };
    const before = await server.app.request('/api/datasets/export', {
      method: 'POST',
      headers,
      body: JSON.stringify({ scope: 'team' }),
    });
    expect(before.status).toBe(200);
    validateDataset(await before.json());
    const hidden = listDecisions(server.db, scope()).items[0]!;
    server.db
      .prepare("UPDATE sessions SET visibility = 'personal' WHERE id = ?")
      .run(hidden.provenance.sessionId);
    expect(exportDataset(server.db, scope()).examples.some((e) => e.id === hidden.id)).toBe(false);
    const detail = await server.app.request(`/api/decisions/${hidden.id}`, { headers });
    expect(detail.status).toBe(404);
    const personal = await server.app.request(`/api/decisions/${hidden.id}?scope=personal`, { headers });
    expect(personal.status).toBe(200);
    const invalid = await server.app.request('/api/datasets/export', {
      method: 'POST',
      headers,
      body: JSON.stringify({ scope: 'everyone' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('refuses tampering, future feature fields and a one-group evaluation', () => {
    seed(1);
    const d = exportDataset(server.db, scope());
    expect(() => evaluateDataset(d)).toThrow('Insufficient independent');
    const tampered = structuredClone(d);
    tampered.examples[0]!.target.choice = 'revise_command';
    expect(() => validateDataset(tampered)).toThrow();
    const future = structuredClone(d);
    Object.assign(future.examples[0]!.input.state, { outcome: 'future' });
    future.manifest.datasetHash = datasetHash(future);
    expect(() => validateDataset(future)).toThrow('Invalid decision input');
  });

  it('deduplicates copied examples and prevents identical inputs crossing splits', () => {
    const first = trace('same');
    fullReplaceSession(server.db, member.memberId, first);
    fullReplaceSession(server.db, member.memberId, { ...first, id: 'codex:copy', sourceSessionId: 'copy' });
    extractDecisions(server.db, scope());
    const d: DecisionDataset = exportDataset(server.db, scope());
    expect(d.examples).toHaveLength(1);
    expect(d.manifest.excluded['duplicate-example']).toBe(1);
  });
});
