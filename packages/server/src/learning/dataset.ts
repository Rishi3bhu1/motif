import type { DecisionDataset, DecisionExample, DecisionInput, RecoveryChoice } from '@motif/core';
import type { Db } from '../db/database.js';
import { fingerprint } from './extract.js';
import { listDecisions, type LearningScope } from './store.js';

export function datasetHash(dataset: DecisionDataset): string {
  const { datasetHash: _hash, ...manifest } = dataset.manifest;
  return fingerprint({ manifest, examples: dataset.examples });
}

export function exportDataset(db: Db, opts: LearningScope): DecisionDataset {
  const result = listDecisions(db, opts);
  if (result.needsExtraction)
    throw new Error('Sources changed or have not been analyzed. Run motif decisions extract first.');
  const excluded: Record<string, number> = {};
  const seen = new Set<string>();
  const examples: DecisionExample[] = [];
  const parent = new Map<string, string>();
  const root = (x: string): string => {
    let at = x;
    while (parent.has(at)) at = parent.get(at)!;
    return at;
  };
  const join = (a: string, b: string) => {
    a = root(a);
    b = root(b);
    if (a !== b) parent.set(a > b ? a : b, a > b ? b : a);
  };
  const inputs = new Map<string, string>();
  for (const d of result.items) {
    if (!d.quality.eligible) {
      for (const reason of d.quality.reasons) excluded[reason] = (excluded[reason] ?? 0) + 1;
      continue;
    }
    // Whole sessions stay together; identical decision inputs also connect
    // groups, even if they produced different actions or outcomes.
    const group = fingerprint(d.provenance.sessionId);
    const inputHash = fingerprint(d.input);
    const prev = inputs.get(inputHash);
    if (prev) join(prev, group);
    inputs.set(inputHash, group);
    const duplicate = fingerprint([d.input, d.action.command, d.outcome]);
    if (seen.has(duplicate)) {
      excluded['duplicate-example'] = (excluded['duplicate-example'] ?? 0) + 1;
      continue;
    }
    seen.add(duplicate);
    examples.push({
      id: d.id,
      input: d.input,
      target: { choice: d.observedChoice, basis: 'observed-behavior' },
      experience: d,
      group,
      split: 'train',
    });
  }
  if (!examples.length)
    throw new Error(
      'No eligible decision examples. Inspect motif decisions --json for coverage and exclusion reasons.',
    );
  for (const example of examples) example.group = root(example.group);
  const groups = [...new Set(examples.map((e) => e.group))].sort();
  const testCount = groups.length < 2 ? 0 : Math.max(1, Math.floor(groups.length * 0.2));
  const testGroups = new Set(groups.slice(groups.length - testCount));
  for (const example of examples) example.split = testGroups.has(example.group) ? 'test' : 'train';
  const dataset: DecisionDataset = {
    manifest: {
      schema: 'motif-decisions/v1',
      category: 'command_recovery',
      purpose: 'imitation',
      scope: opts.scope,
      extractor: 'command_recovery/v1',
      qualityPolicy: 'recovery/v1',
      splitPolicy: 'group-hash/v1',
      candidates: result.candidates,
      excluded,
      examples: examples.length,
      groups: groups.length,
      datasetHash: '',
    },
    examples,
  };
  dataset.manifest.datasetHash = datasetHash(dataset);
  return dataset;
}

const choices: RecoveryChoice[] = ['retry_unchanged', 'revise_command'];
export function validateInput(input: DecisionInput): void {
  if (
    !input ||
    Object.keys(input).sort().join(',') !== 'category,choices,choicesOrigin,state' ||
    input.category !== 'command_recovery' ||
    input.choicesOrigin !== 'recipe-defined' ||
    JSON.stringify(input.choices) !== JSON.stringify(choices) ||
    !input.state ||
    typeof input.state.failedCommand !== 'string' ||
    typeof input.state.failureText !== 'string' ||
    !Number.isSafeInteger(input.state.failureExitCode) ||
    input.state.failureExitCode <= 0 ||
    Object.keys(input.state).sort().join(',') !== 'failedCommand,failureExitCode,failureText'
  )
    throw new Error('Invalid decision input');
}

/** Validation applies equally to local exports and externally supplied files. */
export function validateDataset(value: unknown): asserts value is DecisionDataset {
  const d = value as DecisionDataset;
  if (
    !d?.manifest ||
    d.manifest.schema !== 'motif-decisions/v1' ||
    d.manifest.purpose !== 'imitation' ||
    !Array.isArray(d.examples) ||
    d.examples.length === 0
  )
    throw new Error('Unsupported or empty decision dataset');
  const ids = new Set<string>();
  const groups = new Map<string, string>();
  const sourceGroups = new Map<string, string>();
  const inputGroups = new Map<string, string>();
  for (const e of d.examples) {
    validateInput(e.input);
    if (
      typeof e.id !== 'string' ||
      ids.has(e.id) ||
      !choices.includes(e.target?.choice) ||
      e.target.basis !== 'observed-behavior' ||
      !['train', 'test'].includes(e.split) ||
      typeof e.group !== 'string' ||
      !e.experience?.quality?.eligible ||
      e.experience.id !== e.id ||
      e.experience.observedChoice !== e.target.choice ||
      fingerprint(e.input) !== fingerprint(e.experience.input)
    )
      throw new Error('Invalid or duplicate decision example');
    ids.add(e.id);
    if (groups.has(e.group) && groups.get(e.group) !== e.split)
      throw new Error('A group crosses evaluation splits');
    groups.set(e.group, e.split);
    for (const [map, key] of [
      [sourceGroups, e.experience.provenance.sessionId],
      [inputGroups, fingerprint(e.input)],
    ] as const) {
      if (map.has(key) && map.get(key) !== e.group) throw new Error('Related examples cross groups');
      map.set(key, e.group);
    }
  }
  if (
    d.manifest.examples !== d.examples.length ||
    d.manifest.groups !== groups.size ||
    d.manifest.datasetHash !== datasetHash(d)
  )
    throw new Error('Dataset manifest or content hash mismatch');
}
