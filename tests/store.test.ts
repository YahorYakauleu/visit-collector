import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Counters, OTHER } from '../src/counters.js';
import { parseEvent } from '../src/event.js';
import { openStore } from '../src/store.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';
const at = (iso: string) => Date.parse(iso);
const visit = (iso: string, p: object = {}, ua = IPHONE) =>
  parseEvent(JSON.stringify({ event: 'visit', site: 'a.example', path: '/sport', ...p }), { 'user-agent': ua, 'cf-ipcountry': 'US' }, at(iso), 'America/New_York')!;

describe('Counters', () => {
  it('складывает события одних суток и разрезов в одну строку; боты — отдельно', () => {
    const counters = new Counters();
    counters.add(visit('2026-10-14T15:01:00Z'));
    counters.add(visit('2026-10-14T23:59:00Z'));
    counters.add(visit('2026-10-14T15:30:00Z', {}, 'Googlebot/2.1'));
    counters.add(visit('2026-10-15T05:00:00Z')); // 15.10 по Нью-Йорку
    const rows = counters.drain();
    expect(rows.map((r) => [r.day, r.event, r.device, r.count, r.bots])).toEqual([
      ['2026-10-14', 'visit', 'mobile', 2, 0],
      ['2026-10-14', 'visit', 'desktop', 0, 1],
      ['2026-10-15', 'visit', 'mobile', 1, 0],
    ]);
    expect(counters.drain()).toEqual([]); // после сброса — с нуля
  });

  it('слишком много разных сочетаний — новые пути сворачиваются в «(other)»', () => {
    const counters = new Counters();
    for (let i = 0; i < 200_000; i++) counters.add(visit('2026-10-14T15:00:00Z', { path: `/p${i}` }));
    counters.add(visit('2026-10-14T15:00:00Z', { path: '/new-1' }));
    counters.add(visit('2026-10-14T15:00:00Z', { path: '/new-2' }));
    counters.add(visit('2026-10-14T15:00:00Z', { path: '/p5' })); // уже известный — как обычно
    const rows = counters.drain();
    expect(rows).toHaveLength(200_001);
    expect(rows.find((r) => r.path === OTHER)?.count).toBe(2);
    expect(rows.find((r) => r.path === '/p5')?.count).toBe(2);
  });
});

describe('Store', () => {
  function seeded() {
    const store = openStore(':memory:');
    const counters = new Counters();
    counters.add(visit('2026-10-13T03:30:00Z')); // 12.10 по Нью-Йорку
    counters.add(visit('2026-10-13T05:00:00Z')); // 13.10 по Нью-Йорку
    counters.add(visit('2026-10-13T05:10:00Z', { path: '/movies' }));
    counters.add(visit('2026-10-13T05:15:00Z', { path: '/movies' }));
    counters.add(visit('2026-10-13T06:00:00Z', { path: '' }));
    store.add(counters.drain());
    return store;
  }
  const query = { events: [], group: null, filters: {} };

  it('повторная запись тех же суток и разрезов прибавляется к счётчикам', () => {
    const store = seeded();
    const counters = new Counters();
    counters.add(visit('2026-10-13T05:20:00Z'));
    store.add(counters.drain());
    const day = store.stats({ ...query, from: '2026-10-13', to: '2026-10-13', group: 'path' });
    expect(day.find((r) => r.value === '/sport')).toMatchObject({ count: 2 }); // 03:30 UTC — ещё 12.10 по Нью-Йорку
  });

  it('по дням и событиям (сутки посчитаны при приёме); разрез: по убыванию, «не определено» (null) — в конце', () => {
    const store = seeded();
    expect(store.stats({ ...query, from: '2026-10-12', to: '2026-10-13' })).toEqual([
      { day: '2026-10-12', event: 'visit', value: null, count: 1, bots: 0 },
      { day: '2026-10-13', event: 'visit', value: null, count: 4, bots: 0 },
    ]);
    expect(store.stats({ ...query, from: '2026-10-13', to: '2026-10-13', group: 'path' }).map((r) => [r.value, r.count])).toEqual([
      ['/movies', 2],
      ['/sport', 1],
      [null, 1],
    ]);
  });

  it('фильтры: событие; несколько значений — через ИЛИ, none — не определено', () => {
    const store = seeded();
    const total = (q: object) =>
      store.stats({ ...query, from: '2026-10-13', to: '2026-10-13', ...q }).reduce((s, r) => s + r.count, 0);
    expect(total({ events: ['visit'] })).toBe(4);
    expect(total({ filters: { path: ['/movies'] } })).toBe(2);
    expect(total({ filters: { path: ['/movies', 'none'] } })).toBe(3);
    expect(total({ filters: { path: ['none'] } })).toBe(1);
    expect(total({ filters: { path: ['/sport'], country: ['US'] } })).toBe(1);
    expect(total({ filters: { country: ['SA'] } })).toBe(0);
  });

  it('новый разрез без миграции: у строк, записанных до него, он не определён', () => {
    const store = openStore(':memory:');
    // строка из времени, когда разреза «путь» ещё не было
    store.db.prepare(`INSERT INTO events (day, event, dims, count, bots) VALUES ('2026-10-13', 'visit', '{"site":"a.example"}', 3, 0)`).run();
    const counters = new Counters();
    counters.add(visit('2026-10-13T15:00:00Z'));
    store.add(counters.drain());
    expect(store.stats({ ...query, from: '2026-10-13', to: '2026-10-13', group: 'path' }).map((r) => [r.value, r.count])).toEqual([
      ['/sport', 1],
      [null, 3],
    ]);
    expect(store.stats({ ...query, from: '2026-10-13', to: '2026-10-13', group: 'site' }).map((r) => [r.value, r.count])).toEqual([['a.example', 4]]);
  });

  it('старая таблица счётчиков визитов удаляется, события пишутся в новую', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'visits-')), 'visits.sqlite');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE counters (day TEXT NOT NULL, visits INTEGER NOT NULL)');
    old.close();
    const store = openStore(file);
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    expect(tables).toEqual(['events']);
  });
});
