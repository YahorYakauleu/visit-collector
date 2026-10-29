import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Counters } from '../src/counters.js';
import { createServer } from '../src/server.js';
import { openStore } from '../src/store.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';
const LANDING = 'https://toggle.example';
const VISIT = JSON.stringify({ event: 'visit' });
let close: () => void = () => {};
afterEach(() => close());

async function start(env: Record<string, string> = {}) {
  const config = loadConfig({ READ_TOKEN: 'secret', ALLOWED_ORIGINS: `${LANDING}/, https://other.example`, RATE_LIMIT_PER_MINUTE: '5', ...env });
  const counters = new Counters();
  const store = openStore(':memory:');
  const now = () => Date.parse('2026-10-14T15:00:00Z');
  const server = createServer({ config, counters, store, now }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // браузерный sendBeacon: text/plain, Origin лендинга
  const beacon = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/events`, { method: 'POST', body, headers: { 'content-type': 'text/plain', origin: LANDING, 'user-agent': IPHONE, ...headers } });
  return { url, counters, store, beacon };
}

describe('server', () => {
  it('/health и неизвестные пути', async () => {
    const { url } = await start();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  it('событие: 204 и счётчик; CORS — для своих доменов; чужой домен — 403', async () => {
    const { counters, beacon, url } = await start();
    const ok = await beacon(VISIT);
    expect([ok.status, ok.headers.get('access-control-allow-origin')]).toEqual([204, LANDING]);
    expect(counters.size).toBe(1);
    expect((await beacon(VISIT, { origin: 'https://evil.example' })).status).toBe(403);
    const preflight = await fetch(`${url}/v1/events`, { method: 'OPTIONS', headers: { origin: LANDING } });
    expect([preflight.status, preflight.headers.get('access-control-allow-methods')]).toEqual([204, 'POST']);
  });

  it('кривое событие или имя не из списка — 400, слишком большое — 413, больше лимита с одного IP — 429', async () => {
    const { beacon } = await start();
    expect((await beacon('not json')).status).toBe(400);
    expect((await beacon(JSON.stringify({ event: 'trial' }))).status).toBe(400);
    expect((await beacon(JSON.stringify({ event: 'visit', source: 'x'.repeat(5_000) }))).status).toBe(413);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await beacon(VISIT, { 'x-forwarded-for': '1.2.3.4' })).status);
    expect(statuses).toEqual([204, 204, 204, 204, 204, 429]);
    expect((await beacon(VISIT, { 'x-forwarded-for': '5.6.7.8' })).status).toBe(204); // другой IP — свой лимит
  });

  it('/api/stats — по токену; отдаёт счётчики событий по дням и разрезу', async () => {
    const { url, counters, store, beacon } = await start();
    await beacon(VISIT); // сайт не передан — берётся из Origin
    await beacon(JSON.stringify({ event: 'visit', site: 'toggle.example' }));
    store.add(counters.drain()); // как раз в минуту в main.ts
    const query = `${url}/api/stats?from=2026-10-14&to=2026-10-14&event=visit&group=site`;
    expect((await fetch(query)).status).toBe(401);
    expect((await fetch(query, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const res = await fetch(query, { headers: { authorization: 'Bearer secret' } });
    expect(await res.json()).toEqual({
      from: '2026-10-14',
      to: '2026-10-14',
      time_zone: 'America/New_York', // сутки — из TIMEZONE, по умолчанию как у Stripe
      group: 'site',
      rows: [{ day: '2026-10-14', event: 'visit', value: 'toggle.example', count: 2, bots: 0 }],
    });
    const bad = (q: string) => fetch(`${url}/api/stats?${q}`, { headers: { authorization: 'Bearer secret' } }).then((r) => r.status);
    expect(await bad('from=14.10.2026&to=2026-10-14')).toBe(400);
    expect(await bad('from=2026-10-14&to=2026-10-14&group=ip')).toBe(400);
    expect(await bad('from=2026-10-14&to=2026-10-13')).toBe(400);
    expect(await bad('from=2026-10-14&to=2026-10-14&event=trial')).toBe(400);
  });
});
