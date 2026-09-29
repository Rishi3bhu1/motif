import { Command } from 'commander';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { MotifSession } from '@motif/core';
import {
  applyNotes,
  createServer,
  fullReplaceSession,
  listReviewQueue,
  recall,
  registerMember,
  startServer,
  whenListening,
  type Db,
} from '@motif/server';
import { registerMemory } from '../commands/memory.js';
import { registerRecall } from '../commands/recall.js';
import { saveConfig } from '../config.js';

export const GATE_QUERY = 'cache key tenant isolation';
export const GATE_PROJECT = '/workspace/cache-service';
export const GATE_ACCEPT = 'Shared cache keys must include tenant_id to preserve tenant isolation.';
export const GATE_REJECT =
  'Query params alone are enough for shared cache keys; tenant isolation needs no tenant_id.';

/** Hand-written sessions and extracted claims; the shipping admission policy
 * handles the claims. No model, history reader, sync daemon or agent runs. */
export function seedGateDemo(db: Db) {
  const ada = registerMember(db, { name: 'ada' });
  const ben = registerMember(db, { name: 'ben' });
  const reviewer = registerMember(db, { name: 'you' });
  const timestamp = new Date().toISOString();
  for (const [author, source, id, body] of [
    [ada, 'claude-code', 'demo-cache-isolation', GATE_ACCEPT],
    [ben, 'codex', 'demo-cache-shortcut', GATE_REJECT],
  ] as const) {
    const session: MotifSession = {
      id: `${source}:${id}`,
      source,
      sourceSessionId: id,
      sourcePath: `/workspace/.demo/${id}.jsonl`,
      projectPath: GATE_PROJECT,
      gitBranch: 'main',
      title: source === 'codex' ? 'A proposed shortcut' : 'A proposed isolation rule',
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        { id: `${id}-request`, role: 'user', timestamp, text: 'Propose a rule for the shared cache.' },
        { id: `${id}-reply`, role: 'assistant', timestamp, text: body },
      ],
      filesTouched: ['src/cache/keys.ts'],
      meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
    };
    const { pk } = fullReplaceSession(db, author.memberId, session);
    applyNotes(db, [{ entity: { kind: 'decision', name: 'cache-keys' }, aspect: 'policy', body }], {
      projectPath: GATE_PROJECT,
      sessionPk: pk,
      memberId: author.memberId,
      gate: true,
    });
  }
  const proposals = listReviewQueue(db, reviewer.memberId);
  return {
    reviewer,
    acceptId: proposals.find((item) => item.note.body === GATE_ACCEPT)!.note.id,
    rejectId: proposals.find((item) => item.note.body === GATE_REJECT)!.note.id,
  };
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** A shell function scoped to this client, including every reader override.
 * Sourcing it does not redirect the user's normal agent homes or sync config. */
function prepareClient(dir: string, base: string, reviewer: ReturnType<typeof registerMember>): string {
  const isolated = {
    MOTIF_HOME: path.join(dir, 'client'),
    MOTIF_DB_PATH: path.join(dir, 'demo.db'),
    CODEX_HOME: path.join(dir, 'codex'),
    MOTIF_CURSOR_DIR: path.join(dir, 'cursor'),
  };
  const claudeDir = path.join(dir, 'claude');
  for (const subdir of [isolated.MOTIF_HOME, isolated.CODEX_HOME, isolated.MOTIF_CURSOR_DIR, claudeDir]) {
    fs.mkdirSync(subdir, { recursive: true, mode: 0o700 });
  }
  // The guided take runs the real CLI handlers in this process. These values
  // affect only the demo process; the shell helper below applies them per call.
  Object.assign(process.env, isolated);
  saveConfig({
    serverUrl: base,
    memberToken: reviewer.memberToken,
    memberId: reviewer.memberId,
    name: 'you',
    syncMode: 'selected',
    include: [],
    teamProjects: [],
    allowAsks: false,
  });
  const entry = path.resolve(process.argv[1]!);
  const invocation = [process.execPath, ...process.execArgv, entry, '--claude-dir', claudeDir]
    .map(shellQuote)
    .join(' ');
  const env = Object.entries(isolated)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  const file = path.join(dir, 'gate-env.sh');
  fs.writeFileSync(
    file,
    `# Temporary client for the synthetic admission demo.\nmotif() {\n  ${env} ${invocation} "$@"\n}\n`,
    { mode: 0o600 },
  );
  return file;
}

export async function runGateDemo(
  dir: string,
  opts: { port: string; open: boolean; auto?: boolean; fast?: boolean; prepare?: boolean },
): Promise<void> {
  dir = path.resolve(dir);
  const server = createServer({ dbPath: path.join(dir, 'demo.db'), teamName: 'Motif Demo' });
  const port = Number(opts.port) || 4699;
  const listener = startServer(server, { port, hostname: '127.0.0.1' });
  try {
    await whenListening(listener);
    const base = `http://127.0.0.1:${port}`;
    const { reviewer, acceptId, rejectId } = seedGateDemo(server.db);
    const envFile = prepareClient(dir, base, reviewer);
    const url = `${base}/?token=${encodeURIComponent(reviewer.memberToken)}#/review`;
    // Keep the token off the terminal, including --no-open recordings.
    fs.writeFileSync(path.join(dir, 'dashboard-url.txt'), url + '\n', { mode: 0o600 });
    if (opts.open) {
      const opener =
        process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(opener, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () =>
        console.log('  Browser did not open; the sign-in URL is in dashboard-url.txt.'),
      );
      child.unref();
    }

    console.log('\n  The fleet proposes. A human decides.\n');
    console.log('  Self-hosted. Synthetic sessions and proposals. Real admission engine.');
    console.log('  No API key, model call or real agent history needed for this demo.');
    console.log('  The gate controls decision notes; source transcripts stay searchable.\n');
    console.log(`  Dashboard: ${base}/#/review`);
    console.log(`  Manual take, in a second terminal: source ${shellQuote(envFile)}\n`);

    const steps: { args: string[]; caption: string }[] = [
      { args: ['memory', 'review'], caption: 'Two proposals. Neither is an admitted decision.' },
      {
        args: ['recall', GATE_QUERY, '--budget', '350'],
        caption: 'Before approval: source evidence, no admitted decision.',
      },
      { args: ['memory', 'admit', String(acceptId)], caption: 'A human admits the isolation rule.' },
      {
        args: ['memory', 'reject', String(rejectId)],
        caption: 'The shortcut is rejected and stays in the audit record.',
      },
      {
        args: ['recall', GATE_QUERY, '--budget', '350'],
        caption: 'After approval: the isolation rule is human-verified.',
      },
    ];
    const display = (args: string[]) =>
      `motif ${args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;
    if (opts.prepare) {
      for (const step of steps) console.log(`  ${display(step.args)}`);
      console.log('\n  Prepared only. Both proposals are still waiting for you.');
    } else {
      const interactive = !opts.auto && process.stdin.isTTY;
      if (!interactive) console.log('  Scripted rehearsal: the admit/reject choices below are preselected.');
      const rl = interactive
        ? readline.createInterface({ input: process.stdin, output: process.stdout })
        : undefined;
      try {
        for (const step of steps) {
          console.log(`\n  ${step.caption}`);
          if (rl) await rl.question('  Press Enter to run the next command...');
          else if (!opts.fast) await new Promise((resolve) => setTimeout(resolve, 1800));
          console.log(`\n$ ${display(step.args)}\n`);
          const cli = new Command('motif');
          registerMemory(cli);
          registerRecall(cli);
          await cli.parseAsync(step.args, { from: 'user' });
          if (step.args[0] === 'recall') {
            const result = recall(server.db, { query: GATE_QUERY, viewerId: reviewer.memberId });
            const notes = result.items.filter((item) => item.kind === 'note');
            console.log(`\n  Admitted decision notes in this recall: ${notes.length}`);
          }
        }
      } finally {
        rl?.close();
      }
      console.log('\n  One accepted decision. The rejected proposal remains in the record.');
      console.log('  Raw source excerpts are evidence, not approved team decisions.');
    }
    console.log(`\n  Review: ${base}/#/review  ·  Memory: ${base}/#/memory  ·  Weave: ${base}/#/weave`);
    console.log('  Ctrl+C stops the server. Run the same demo command again for a fresh take.');
  } catch (error) {
    listener.close();
    server.db.close();
    throw error;
  }
}
