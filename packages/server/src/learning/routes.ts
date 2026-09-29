import type { Hono } from 'hono';
import type { Db } from '../db/database.js';
import { exportDataset } from './dataset.js';
import { extractDecisions, listDecisions, type LearningScope } from './store.js';

export function learningScope(viewerId: number, value: Record<string, unknown>): LearningScope {
  if (value.scope !== undefined && value.scope !== 'team' && value.scope !== 'personal')
    throw new Error('scope must be team or personal');
  if (value.project !== undefined && (typeof value.project !== 'string' || value.project.length > 4096))
    throw new Error('invalid project');
  if (value.category !== undefined && value.category !== 'command_recovery')
    throw new Error('Only command_recovery is supported');
  return {
    viewerId,
    scope: value.scope === 'personal' ? 'personal' : 'team',
    project: value.project as string | undefined,
  };
}

export function registerLearningRoutes(app: Hono, db: Db): void {
  for (const [method, route, operation] of [
    ['get', '/api/decisions', 'list'],
    ['get', '/api/decisions/:id', 'show'],
    ['post', '/api/decisions/extract', 'extract'],
    ['post', '/api/datasets/export', 'export'],
  ] as const) {
    app[method](route, async (c) => {
      const viewerId = c.get('memberId' as never) as number | undefined;
      if (viewerId === undefined) return c.json({ error: 'Learning requires a member token' }, 403);
      try {
        const body: unknown = method === 'get' ? c.req.query() : await c.req.json();
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new Error('Expected an options object');
        const scope = learningScope(viewerId, body as Record<string, unknown>);
        if (operation === 'extract') return c.json(extractDecisions(db, scope));
        if (operation === 'export') return c.json(exportDataset(db, scope));
        if (operation === 'show') {
          const item = listDecisions(db, scope).items.find((d) => d.id === c.req.param('id'));
          return item ? c.json(item) : c.json({ error: 'not found' }, 404);
        }
        return c.json(listDecisions(db, scope));
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }
    });
  }
}
