import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncOnce, loadState, saveState } from '../packages/cli/src/daemon/syncer.js';
import type { MotifClient } from '../packages/cli/src/api-client.js';

let tmp: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

it('refreshes old normalization, changed receipts with stable IDs, and forced sync', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-sync-evidence-'));
  for (const [key, dir] of Object.entries({
    MOTIF_HOME: 'motif',
    CODEX_HOME: 'codex',
    MOTIF_CURSOR_DIR: 'cursor',
  })) {
    vi.stubEnv(key, path.join(tmp, dir));
    fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  }
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(claudeDir);
  const sessions = path.join(tmp, 'codex', 'sessions');
  fs.mkdirSync(sessions);
  const file = path.join(sessions, 'rollout-2026-01-01T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  const write = (code: number) =>
    fs.writeFileSync(
      file,
      [
        {
          type: 'session_meta',
          payload: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: '/workspace/app' },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'a',
            arguments: JSON.stringify({ cmd: 'npm test' }),
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'a',
            output: JSON.stringify({ output: 'Synthetic receipt', metadata: { exit_code: code } }),
          },
        },
      ]
        .map((row) => JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', ...row }))
        .join('\n'),
    );
  const putSession = vi.fn().mockResolvedValue({});
  const postMessages = vi.fn().mockResolvedValue({});
  const client = { putSession, postMessages } as unknown as MotifClient;
  const cfg = {
    syncMode: 'selected' as const,
    include: ['/workspace/app'],
    teamProjects: ['/workspace/app'],
  };
  write(1);
  expect((await syncOnce(client, cfg, { claudeDir })).replaced).toBe(1);
  expect((await syncOnce(client, cfg, { claudeDir })).unchanged).toBe(1);
  const old = loadState();
  for (const entry of Object.values(old)) delete entry.readerVersion;
  saveState(old);
  expect((await syncOnce(client, cfg, { claudeDir })).replaced).toBe(1);
  write(2);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  expect((await syncOnce(client, cfg, { claudeDir })).replaced).toBe(1);
  expect(putSession.mock.calls.at(-1)![0].messages.at(-1).toolResult.exitCode).toBe(2);
  expect((await syncOnce(client, cfg, { claudeDir, force: true })).replaced).toBe(1);
  expect(postMessages).not.toHaveBeenCalled();
  fs.appendFileSync(
    file,
    '\n' +
      JSON.stringify({
        timestamp: '2026-01-01T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Synthetic final response.' }],
        },
      }),
  );
  expect((await syncOnce(client, cfg, { claudeDir })).appended).toBe(1);
});
