import type { MotifMessage } from './schema.js';

/** Only explicit source receipts qualify. Arbitrary stdout and prose are not
 * scanned for words like "passed" or "success". Evidence is source-reported. */
export function readToolOutcome(value: unknown): MotifMessage['toolResult'] {
  if (typeof value === 'string') {
    try {
      return readToolOutcome(JSON.parse(value));
    } catch {
      /* native text envelope below */
    }
    const match = value.match(
      /^Chunk ID: [^\n]+\r?\nWall time: [^\n]+\r?\n(?:Process exited with code (-?\d+)\r?\n)/,
    );
    if (match) return { exitCode: Number(match[1]), terminal: true };
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const meta =
    obj.metadata && typeof obj.metadata === 'object' ? (obj.metadata as Record<string, unknown>) : obj;
  const code = meta.exit_code ?? meta.exitCode;
  if (typeof code === 'number' && Number.isSafeInteger(code)) return { exitCode: code, terminal: true };
  return undefined;
}
