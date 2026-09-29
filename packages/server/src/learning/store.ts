import type { DecisionExperience, MotifMessage } from '@motif/core';
import type { Db } from '../db/database.js';
import { EXTRACTOR, extractRecovery, type ExtractionSummary } from './extract.js';

export interface LearningScope {
  viewerId: number;
  scope: 'team' | 'personal';
  project?: string;
}
export function scopeSql(opts: LearningScope): { sql: string; args: (string | number)[] } {
  return {
    sql: `s.visibility = ? ${opts.scope === 'personal' ? 'AND s.member_id = ?' : ''} ${opts.project ? 'AND s.project_path = ?' : ''}`,
    args: [
      opts.scope,
      ...(opts.scope === 'personal' ? [opts.viewerId] : []),
      ...(opts.project ? [opts.project] : []),
    ],
  };
}

/** Explicit extraction over ingested data only. No readers or agents run here. */
export function extractDecisions(db: Db, opts: LearningScope) {
  const filter = scopeSql(opts);
  const rows = db
    .prepare(
      `SELECT s.pk, s.id, s.source, s.project_path, s.member_id, s.meta_json, s.experience_revision AS revision FROM sessions s WHERE ${filter.sql} ORDER BY s.pk`,
    )
    .all(...filter.args) as {
    pk: number;
    id: string;
    source: string;
    project_path: string;
    member_id: number;
    meta_json: string;
    revision: number;
  }[];
  db.transaction(() => {
    for (const s of rows) {
      const existing = db
        .prepare('SELECT revision, extractor FROM decision_scans WHERE session_pk = ?')
        .get(s.pk) as { revision: number; extractor: string } | undefined;
      if (existing?.revision === s.revision && existing.extractor === EXTRACTOR) continue;
      const messages = (
        db.prepare('SELECT content_json FROM messages WHERE session_pk = ? ORDER BY seq').all(s.pk) as {
          content_json: string;
        }[]
      ).map((r) => JSON.parse(r.content_json) as MotifMessage);
      const copied = Boolean(
        db
          .prepare('SELECT 1 FROM handoffs WHERE target_session_id = ? LIMIT 1')
          .get(s.id.split(':').slice(1).join(':')),
      );
      const result = extractRecovery(messages, {
        sessionId: s.id,
        source: s.source,
        project: s.project_path,
        identity: `${s.pk}:${s.member_id}:${s.id}`,
        copied,
        parseErrors: Number(JSON.parse(s.meta_json).parseErrors ?? 0),
      });
      db.prepare('DELETE FROM decision_events WHERE session_pk = ?').run(s.pk);
      for (const d of result.decisions) {
        db.prepare('INSERT INTO decision_events VALUES (?, ?, ?, ?, ?)').run(
          d.id,
          s.pk,
          s.revision,
          'command_recovery',
          JSON.stringify(d),
        );
        for (const e of d.provenance.evidence)
          db.prepare('INSERT INTO decision_evidence VALUES (?, ?, ?, ?)').run(
            d.id,
            e.messageId,
            e.role,
            e.hash,
          );
      }
      db.prepare('INSERT OR REPLACE INTO decision_scans VALUES (?, ?, ?, ?)').run(
        s.pk,
        s.revision,
        EXTRACTOR,
        JSON.stringify(result.summary),
      );
    }
  })();
  return listDecisions(db, opts);
}

export function listDecisions(db: Db, opts: LearningScope) {
  const filter = scopeSql(opts);
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN r.revision = s.experience_revision AND r.extractor = ? THEN 1 ELSE 0 END) AS analyzed FROM sessions s LEFT JOIN decision_scans r ON r.session_pk = s.pk WHERE ${filter.sql}`,
    )
    .get(EXTRACTOR, ...filter.args) as { total: number; analyzed: number | null };
  const rows = db
    .prepare(
      `SELECT d.body_json, s.pk FROM decision_events d JOIN sessions s ON s.pk = d.session_pk WHERE d.revision = s.experience_revision AND ${filter.sql} ORDER BY d.id`,
    )
    .all(...filter.args) as { body_json: string; pk: number }[];
  const items = rows.map((r) => {
    const d = JSON.parse(r.body_json) as DecisionExperience;
    const notes = db
      .prepare('SELECT id, status, verification FROM memory_notes WHERE source_session_pk = ? ORDER BY id')
      .all(r.pk) as { id: number; status: string; verification: string }[];
    d.feedback = notes.map((note) => ({
      relation: 'source-session',
      noteId: note.id,
      status: note.status,
      verification: note.verification,
      reviews: db
        .prepare('SELECT id, verdict, reason, created_at FROM memory_reviews WHERE note_id = ? ORDER BY id')
        .all(note.id) as NonNullable<DecisionExperience['feedback']>[number]['reviews'],
      actions: db
        .prepare('SELECT id, status, resolution FROM weaver_jobs WHERE source_note_id = ? ORDER BY id')
        .all(note.id) as NonNullable<DecisionExperience['feedback']>[number]['actions'],
    }));
    if (
      db
        .prepare('SELECT 1 FROM handoffs WHERE target_session_id = ? LIMIT 1')
        .get(d.provenance.sessionId.split(':').slice(1).join(':'))
    )
      d.quality.reasons.push('copied-history');
    // Conservative session-level quarantine, NOT a claim that a note labels
    // this particular action. Recomputed on reads so later rulings take effect.
    const uncertain = db
      .prepare(
        "SELECT id FROM memory_notes WHERE source_session_pk = ? AND (status IN ('conflicted','superseded') OR verification IN ('disputed','retired')) ORDER BY id",
      )
      .all(r.pk) as { id: number }[];
    if (uncertain.length)
      d.quality.reasons.push(`source-memory-needs-review:${uncertain.map((n) => n.id).join(',')}`);
    d.quality.eligible = d.quality.reasons.length === 0;
    return d;
  });
  const excluded: Record<string, number> = {};
  const scans = db
    .prepare(
      `SELECT r.summary_json FROM decision_scans r JOIN sessions s ON s.pk = r.session_pk WHERE r.revision = s.experience_revision AND r.extractor = ? AND ${filter.sql}`,
    )
    .all(EXTRACTOR, ...filter.args) as { summary_json: string }[];
  let toolCalls = 0;
  let observedFailures = 0;
  for (const row of scans) {
    const scan = JSON.parse(row.summary_json) as ExtractionSummary;
    toolCalls += scan.toolCalls;
    observedFailures += scan.observedFailures;
    for (const [reason, n] of Object.entries(scan.excluded)) excluded[reason] = (excluded[reason] ?? 0) + n;
  }
  return {
    category: 'command_recovery',
    sessions: counts.total,
    analyzed: counts.analyzed ?? 0,
    needsExtraction: counts.total - (counts.analyzed ?? 0),
    toolCalls,
    observedFailures,
    candidates: items.length,
    eligible: items.filter((d) => d.quality.eligible).length,
    skippedEvidence: excluded,
    items,
  };
}
export type LearningSummary = ReturnType<typeof listDecisions>;
