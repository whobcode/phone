import { Hono } from 'hono';

type Env = {
  UPSTREAM_BASE_URL: string;
  PHONE_CACHE: KVNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  TASKS: DurableObjectNamespace;
  PHONE_TASKS: Queue<unknown>;
  DB: D1Database;
  API_KEY?: string;
};

export class RateLimiter {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }
  async allow(key: string, limit = 60, windowSec = 60): Promise<boolean> {
    const now = Date.now();
    const bucket = Math.floor(now / (windowSec * 1000));
    const stored = (await this.state.storage.get<{ b: number; c: number }>(key)) || { b: bucket, c: 0 };
    if (stored.b !== bucket) {
      stored.b = bucket; stored.c = 0;
    }
    if (stored.c >= limit) return false;
    stored.c += 1;
    await this.state.storage.put(key, stored, { expirationTtl: windowSec * 2 });
    return true;
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/allow') {
      const body = await req.json().catch(() => ({}));
      const ok = await this.allow(body.key || 'default');
      return new Response(null, { status: ok ? 200 : 429 });
    }
    return new Response('Not Found', { status: 404 });
  }
}

export class TasksDO {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }
  async get(id: string) {
    return (await this.state.storage.get(id)) || null;
  }
  async put(id: string, data: unknown) {
    await this.state.storage.put(id, data, { expirationTtl: 86400 });
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    if (url.pathname === '/init' || url.pathname === '/update') {
      if (!body.id) return new Response('id required', { status: 400 });
      await this.put(body.id, body);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith('/get/')) {
      const id = url.pathname.split('/').pop()!;
      const data = await this.get(id);
      return new Response(JSON.stringify(data || {}), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  }
}

const app = new Hono<{ Bindings: Env }>();

// Auth middleware for API routes (bearer token or X-Api-Key)
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();
  const auth = c.req.header('authorization') || '';
  const apiKey = c.req.header('x-api-key') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const expected = c.env.API_KEY || '';
  if (expected && (token === expected || apiKey === expected)) return next();
  return c.json({ error: 'unauthorized' }, 401);
});

app.get('/api/health', (c) => c.json({ ok: true }));

app.post('/api/lookup', async (c) => {
  const ip = c.req.header('cf-connecting-ip') || 'anon';
  const limiterId = c.env.RATE_LIMITER.idFromName(ip);
  const limiter = c.env.RATE_LIMITER.get(limiterId);
  // call allow via DO stub fetch
  const allowed = await limiter.fetch('https://do/allow', { method: 'POST', body: JSON.stringify({ key: 'lookup' }) }).then(r => r.ok);
  if (!allowed) return c.json({ error: 'rate_limited' }, 429);

  const { number } = await c.req.json<{ number?: string }>().catch(() => ({} as any));
  if (!number) return c.json({ error: 'number required' }, 400);

  const cacheKey = `lookup:${number}`;
  const cached = await c.env.PHONE_CACHE.get(cacheKey, { type: 'json' });
  if (cached) return c.json(cached as any);

  const url = new URL('/lookup', c.env.UPSTREAM_BASE_URL);
  url.searchParams.set('number', number);
  const res = await fetch(url.toString(), { headers: { 'accept': 'application/json' } });
  if (!res.ok) return c.json({ error: 'upstream_error', status: res.status }, 502);
  const data = await res.json();
  await c.env.PHONE_CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 });
  try {
    await c.env.DB.prepare(
      'INSERT INTO lookups (number, response_json, created_at) VALUES (?, ?, datetime("now"))'
    ).bind(number, JSON.stringify(data)).run();
  } catch (e) {
    // ignore DB errors to not impact response
  }
  return c.json(data);
});

app.post('/api/task', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const id = crypto.randomUUID();
  const tasksId = c.env.TASKS.idFromName(id);
  const tasks = c.env.TASKS.get(tasksId);
  await tasks.fetch('https://do/init', { method: 'POST', body: JSON.stringify({ id, status: 'queued', input: body }) });
  await c.env.PHONE_TASKS.send({ id, body });
  try {
    await c.env.DB.prepare(
      'INSERT INTO tasks (id, status, input_json, created_at, updated_at) VALUES (?, ?, ?, datetime("now"), datetime("now"))'
    ).bind(id, 'queued', JSON.stringify(body)).run();
  } catch {}
  return c.json({ id, status: 'queued' }, 202);
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext) {
    for (const msg of batch.messages) {
      const { id, body } = msg.body as any;
      const url = new URL('/run', env.UPSTREAM_BASE_URL);
      const res = await fetch(url.toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = res.ok ? await res.json().catch(() => ({})) : { error: 'upstream_error', status: res.status };
      const tasksId = env.TASKS.idFromName(id);
      const tasks = env.TASKS.get(tasksId);
      await tasks.fetch('https://do/update', { method: 'POST', body: JSON.stringify({ id, status: res.ok ? 'completed' : 'failed', result }) });
      try {
        await env.DB.prepare(
          'UPDATE tasks SET status = ?, result_json = ?, updated_at = datetime("now") WHERE id = ?'
        ).bind(res.ok ? 'completed' : 'failed', JSON.stringify(result), id).run();
      } catch {}
    }
  },
};

// (Durable Objects expose fetch methods above)
