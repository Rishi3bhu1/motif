import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, listReviewQueue, recall, type MotifServer } from '@motif/server';
import { GATE_ACCEPT, GATE_QUERY, GATE_REJECT, seedGateDemo } from '../packages/cli/src/demo/gate.js';

let tmp: string;
let server: MotifServer;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-gate-test-'));
  server = createServer({ dbPath: path.join(tmp, 'demo.db'), teamName: 'Demo' });
});
afterEach(() => {
  server.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the admission demo', () => {
  it('stages two sourced proposals without pretending their transcripts are hidden', () => {
    const { reviewer, acceptId, rejectId } = seedGateDemo(server.db);
    expect([acceptId, rejectId]).toEqual([1, 2]);
    const queue = listReviewQueue(server.db, reviewer.memberId);
    expect(queue).toHaveLength(2);
    expect(queue.every((item) => item.type === 'proposed')).toBe(true);
    expect(queue.map((item) => item.note.author_name)).toEqual(['ada', 'ben']);
    expect(queue.map((item) => item.note.session_id)).toEqual([
      'claude-code:demo-cache-isolation',
      'codex:demo-cache-shortcut',
    ]);
    const result = recall(server.db, { query: GATE_QUERY, viewerId: reviewer.memberId });
    expect(result.items.filter((item) => item.kind === 'note')).toHaveLength(0);
    const evidence = result.items
      .filter((item) => item.kind === 'excerpt')
      .map((item) => item.text)
      .join('\n');
    expect(evidence).toContain(GATE_ACCEPT);
    expect(evidence).toContain(GATE_REJECT);
    expect(fs.readdirSync(tmp).every((file) => file.startsWith('demo.db'))).toBe(true);
  });

  it('uses authenticated rulings to admit one note and retain the rejected proposal and its source', async () => {
    const { reviewer, acceptId, rejectId } = seedGateDemo(server.db);
    for (const [noteId, verdict] of [
      [acceptId, 'confirm'],
      [rejectId, 'retire'],
    ] as const) {
      const response = await server.app.request(`/api/memory/notes/${noteId}/verdict`, {
        method: 'POST',
        headers: { authorization: `Bearer ${reviewer.memberToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ verdict }),
      });
      expect(response.status).toBe(200);
    }
    const result = recall(server.db, { query: GATE_QUERY, viewerId: reviewer.memberId });
    const notes = result.items.filter((item) => item.kind === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain(GATE_ACCEPT);
    expect(notes[0]!.text).toContain('verified · high confidence');
    expect(notes[0]!.why).toContain('human-verified');
    expect(result.items.some((item) => item.kind === 'excerpt' && item.text.includes(GATE_REJECT))).toBe(
      true,
    );
    expect(listReviewQueue(server.db, reviewer.memberId)).toHaveLength(0);
    expect(
      server.db.prepare('SELECT admitted, verification FROM memory_notes WHERE id = ?').get(rejectId),
    ).toEqual({ admitted: 0, verification: 'retired' });
    expect(server.db.prepare('SELECT reviewer_id, verdict FROM memory_reviews ORDER BY id').all()).toEqual([
      { reviewer_id: reviewer.memberId, verdict: 'confirm' },
      { reviewer_id: reviewer.memberId, verdict: 'retire' },
    ]);
  });
});
