import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import type { DecisionDataset, DecisionExperience, DecisionPrediction } from '@motif/core';
import {
  evaluateDataset,
  exportDataset,
  extractDecisions,
  listDecisions,
  openDb,
  resolveMemberByToken,
  type LearningScope,
} from '@motif/server';
import { loadConfig, motifHome } from '../config.js';
import { MotifClient } from '../api-client.js';

interface Options {
  scope?: string;
  project?: string;
  json?: boolean;
}
type Summary = ReturnType<typeof listDecisions>;

async function request(
  operation: 'list' | 'extract' | 'export',
  opts: Options,
): Promise<Summary | DecisionDataset> {
  if (opts.scope !== undefined && !['team', 'personal'].includes(opts.scope))
    throw new Error('--scope must be team or personal');
  const cfg = loadConfig();
  const scope = opts.scope === 'personal' ? 'personal' : 'team';
  const project = opts.project ? path.resolve(opts.project) : undefined;
  if (cfg.serverUrl && cfg.memberToken) {
    const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
    const opts = { scope, project };
    return operation === 'list'
      ? client.decisions(opts)
      : operation === 'extract'
        ? client.extractDecisions(opts)
        : client.exportDecisionDataset(opts);
  }
  const file = process.env.MOTIF_DB_PATH ?? path.join(motifHome(), 'motif.db');
  if (!fs.existsSync(file))
    throw new Error('No ingested experience database. Connect to an existing Motif server first.');
  const db = openDb(file);
  try {
    const viewerId = cfg.memberToken ? resolveMemberByToken(db, cfg.memberToken) : undefined;
    if (viewerId === undefined)
      throw new Error('Learning requires a valid member identity. Connect to your Motif server first.');
    const scoped: LearningScope = { viewerId, scope, project };
    return operation === 'export'
      ? exportDataset(db, scoped)
      : operation === 'extract'
        ? extractDecisions(db, scoped)
        : listDecisions(db, scoped);
  } finally {
    db.close();
  }
}

function options(command: Command): Command {
  return command
    .option('--scope <scope>', 'team or your personal experience', 'team')
    .option('--project <path>', 'scope to one project')
    .option('--json', 'machine-readable output');
}
function category(value: string): void {
  if (value !== 'command_recovery') throw new Error('Only command_recovery is implemented');
}
function summary(result: Summary, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `Analyzed ${result.analyzed}/${result.sessions} ingested sessions (${result.needsExtraction} need extraction).`,
  );
  console.log(`command_recovery: ${result.candidates} candidates, ${result.eligible} eligible examples.`);
  console.log(
    `${result.toolCalls} tool calls, ${result.observedFailures} explicitly observed command failures.`,
  );
  for (const [reason, n] of Object.entries(result.skippedEvidence)) console.log(`  ${reason}: ${n}`);
  for (const d of result.items)
    console.log(
      `  ${d.id}  ${d.observedChoice}  ${d.quality.eligible ? 'eligible' : d.quality.reasons.join('; ')}`,
    );
  console.log('Observed choices are behavior labels, not proof of optimal decisions.');
}

export function registerLearning(program: Command): void {
  const decisions = options(
    program
      .command('decisions')
      .description('Inspect recurring decisions extracted from ingested experience'),
  );
  decisions.action(async (opts: Options) => summary((await request('list', opts)) as Summary, opts.json));
  options(
    decisions
      .command('extract [category]')
      .description('Extract deterministic decision examples; never reads agent history'),
  ).action(async (name: string = 'command_recovery', opts: Options) => {
    category(name);
    summary((await request('extract', opts)) as Summary, opts.json);
  });
  options(
    decisions
      .command('show <id>')
      .description('Show the input, choice, receipts, outcome and quality reasons'),
  ).action(async (id: string, opts: Options) => {
    const d: DecisionExperience | undefined = ((await request('list', opts)) as Summary).items.find(
      (item) => item.id === id,
    );
    if (!d) throw new Error('Decision not found in this scope (it may need re-extraction).');
    console.log(JSON.stringify(d, null, 2));
  });
  options(
    program.command('dataset <category>').description('Export a versioned decision dataset with provenance'),
  )
    .requiredOption('--out <directory>', 'new output directory; existing files are never overwritten')
    .option('--purpose <purpose>', 'dataset label semantics (imitation)', 'imitation')
    .action(async (name: string, opts: Options & { out: string; purpose: string }) => {
      category(name);
      if (opts.purpose !== 'imitation')
        throw new Error('Only observed-behavior imitation datasets are supported');
      const data = (await request('export', opts)) as DecisionDataset;
      const dir = path.resolve(opts.out);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.mkdirSync(dir, { mode: 0o700 });
      const write = (name: string, text: string) =>
        fs.writeFileSync(path.join(dir, name), text, { mode: 0o600, flag: 'wx' });
      write('dataset.json', JSON.stringify(data, null, 2) + '\n');
      write('manifest.json', JSON.stringify(data.manifest, null, 2) + '\n');
      write('examples.jsonl', data.examples.map((e) => JSON.stringify(e)).join('\n') + '\n');
      write(
        'train.jsonl',
        data.examples
          .filter((e) => e.split === 'train')
          .map((e) => JSON.stringify({ id: e.id, input: e.input, target: e.target }))
          .join('\n') + '\n',
      );
      write(
        'test-inputs.jsonl',
        data.examples
          .filter((e) => e.split === 'test')
          .map((e) => JSON.stringify({ id: e.id, input: e.input, datasetHash: data.manifest.datasetHash }))
          .join('\n') + '\n',
      );
      console.log(
        opts.json
          ? JSON.stringify(data.manifest, null, 2)
          : `Exported ${data.examples.length} examples in ${data.manifest.groups} independent groups to ${dir}.\nDataset ${data.manifest.datasetHash}\nInputs and outcomes are separate. These are observational labels, not ground truth.`,
      );
    });
  program
    .command('eval <dataset>')
    .description('Evaluate held-out decision predictions without running an agent')
    .option('--baseline <name>', 'built-in baseline (majority)')
    .option('--predictions <file>', 'JSON object with datasetHash and predictions array')
    .option('--json', 'machine-readable report')
    .action((file: string, opts: { baseline?: string; predictions?: string; json?: boolean }) => {
      if (opts.baseline && opts.baseline !== 'majority')
        throw new Error('Only the majority baseline is built in');
      if (opts.baseline && opts.predictions) throw new Error('Choose --baseline or --predictions, not both');
      const target = fs.statSync(file).isDirectory() ? path.join(file, 'dataset.json') : file;
      const data = JSON.parse(fs.readFileSync(target, 'utf8')) as DecisionDataset;
      const predictions = opts.predictions
        ? (JSON.parse(fs.readFileSync(opts.predictions, 'utf8')) as {
            datasetHash: string;
            predictions: DecisionPrediction[];
          })
        : undefined;
      const report = evaluateDataset(data, predictions);
      console.log(
        opts.json
          ? JSON.stringify(report, null, 2)
          : `${report.model}: ${report.train} training, ${report.test} held-out examples\nAgreement ${(report.accuracy * 100).toFixed(1)}% · macro-F1 ${report.macroF1.toFixed(3)} · coverage ${(report.coverage * 100).toFixed(1)}%\nMissing ${report.missing} · invalid ${report.invalid} · abstained ${report.abstained}\n${report.limitation}`,
      );
    });
}
