import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { readCodexSession } from '@motif/core';
import { createServer, registerMember } from '@motif/server';
import { saveConfig } from '../config.js';
import { registerLearning } from '../commands/learning.js';

/** A reproducible learning proof. Native envelopes and all content are invented. */
export async function runLearningDemo(dir: string): Promise<void> {
  dir = path.resolve(dir);
  const isolated = {
    MOTIF_HOME: path.join(dir, 'client'),
    MOTIF_DB_PATH: path.join(dir, 'demo.db'),
    CODEX_HOME: path.join(dir, 'codex'),
    MOTIF_CURSOR_DIR: path.join(dir, 'cursor'),
  };
  Object.assign(process.env, isolated);
  for (const sub of ['client', 'codex', 'cursor', 'claude', 'traces'])
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const server = createServer({ dbPath: isolated.MOTIF_DB_PATH, teamName: 'Experience Demo' });
  try {
    const member = registerMember(server.db, { name: 'ada' });
    saveConfig({
      memberId: member.memberId,
      memberToken: member.memberToken,
      name: 'ada',
      syncMode: 'selected',
      include: [],
      teamProjects: [],
      allowAsks: false,
    });
    for (let i = 0; i < 10; i++) {
      const id = `demo-recovery-${i}`;
      const command = `node scripts/check-${i}.js`;
      const output = (code: number, text: string) =>
        JSON.stringify({ output: text, metadata: { exit_code: code } });
      const events = [
        { type: 'session_meta', payload: { id, cwd: '/workspace/app' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `Check synthetic scenario ${i}.` }],
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'first',
            arguments: JSON.stringify({ cmd: command, workdir: '/workspace/app' }),
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'first',
            output: output(1, `Synthetic failure for scenario ${i}.`),
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'second',
            arguments: JSON.stringify({
              cmd: i % 2 ? `${command} --strict` : command,
              workdir: '/workspace/app',
            }),
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'second',
            output: output(i % 3 ? 0 : 1, 'Synthetic follow-up receipt.'),
          },
        },
      ];
      const file = path.join(dir, 'traces', `${id}.jsonl`);
      fs.writeFileSync(
        file,
        events
          .map((e, ordinal) => JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', ordinal, ...e }))
          .join('\n') + '\n',
      );
      const session = readCodexSession(file);
      const response = await server.app.request(`/api/sessions/${session.id}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${member.memberToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...session, visibility: 'team' }),
      });
      if (response.status !== 200) throw new Error(`Demo ingestion failed: ${await response.text()}`);
    }
    console.log('\nMotif: experience into memory and learning.');
    console.log(
      'Ten invented native traces, normal authenticated ingestion, real extraction and evaluation.',
    );
    console.log('No real history, commands, agents, or models are executed.\n');
    const out = path.join(dir, 'dataset');
    for (const args of [
      ['decisions', 'extract', 'command_recovery'],
      ['dataset', 'command_recovery', '--out', out],
      ['eval', out, '--baseline', 'majority'],
    ]) {
      console.log(`\n$ motif ${args.join(' ')}\n`);
      const cli = new Command('motif');
      registerLearning(cli);
      await cli.parseAsync(args, { from: 'user' });
    }
    console.log(`\nInspect the receipts and dataset at ${out}`);
    console.log('These synthetic scores prove the pipeline works, not that agent behavior has improved.');
  } finally {
    server.db.close();
  }
}
