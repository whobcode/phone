import { unstable_dev } from '@cloudflare/vitest-pool-workers/runtime';
import { afterAll, beforeAll, expect, test } from 'vitest';

let worker: any;

beforeAll(async () => {
  worker = await unstable_dev('worker.ts', { config: 'wrangler.jsonc' });
});

afterAll(async () => {
  await worker?.stop();
});

test('health endpoint', async () => {
  const res = await worker.fetch('/api/health');
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.ok).toBe(true);
});

