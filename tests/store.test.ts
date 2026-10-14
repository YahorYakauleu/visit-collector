import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Counters, OTHER } from '../src/counters.js';
import { openStore } from '../src/store.js';
import { parseVisit } from '../src/visit.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';
const at = (iso: string) => Date.parse(iso);
const visit = (iso: string, p: object = {}, ua = IPHONE) =>
  parseVisit(JSON.stringify({ first: true, source: 'facebook', ...p }), { 'user-agent': ua, 'cf-ipcountry': 'US' }, at(iso), 'America/New_York')!;

describe('Counters', () => {
  it('складывает визиты одних суток и разрезов в одну строку; первые визиты — посетители; боты — отдельно', () => {
    const counters = new Counters();
    counters.add(visit('2026-10-14T15:01:00Z'));
    counters.add(visit('2026-10-14T23:59:00Z', { first: false }));
    counters.add(visit('2026-10-14T15:30:00Z', {}, 'Googlebot/2.1'));
    counters.add(visit('2026-10-15T05:00:00Z')); // 15.10 по Нью-Йорку
    const rows = counters.drain();
    expect(rows.map((r) => [r.day, r.device, r.visitors, r.visits, r.bots])).toEqual([
      ['2026-10-14', 'mobile', 1, 2, 0],
      ['2026-10-14', 'desktop', 0, 0, 1],
      ['2026-10-15', 'mobile', 1, 1, 0],
    ]);
    expect(counters.drain()).toEqual([]); // после сброса — с нуля
  });

  it('триал: +1 к оформленным в сутки оформления и +1 к триалам когорты в сутки первого визита', () => {
    const counters = new Counters();
    const trial = (firstVisit?: string) =>
      parseVisit(JSON.stringify({ event: 'trial', first_visit: firstVisit }), { 'user-agent': IPHONE }, at('2026-10-14T15:00:00Z'), 'America/New_York')!;
    counters.add(trial('2026-10-13T12:00:00Z'));
    counters.add(trial()); // первый визит неизвестен — только оформленный
    expect(counters.drain().map((r) => [r.day, r.visits, r.trials, r.trials_started])).toEqual([
      ['2026-10-14', 0, 0, 2],
      ['2026-10-13', 0, 1, 0],
    ]);
  });

  it('слишком много разных сочетаний — новые кампании сворачиваются в «(other)»', () => {
    const counters = new Counters();
    for (let i = 0; i < 200_000; i++) counters.add(visit('2026-10-14T15:00:00Z', { campaign: `c${i}` }));
    counters.add(visit('2026-10-14T15:00:00Z', { campaign: 'new-1' }));
    counters.add(visit('2026-10-14T15:00:00Z', { campaign: 'new-2' }));
    counters.add(visit('2026-10-14T15:00:00Z', { campaign: 'c5' })); // уже известная — как обычно
    const rows = counters.drain();
    expect(rows).toHaveLength(200_001);
    expect(rows.find((r) => r.campaign === OTHER)?.visitors).toBe(2);
    expect(rows.find((r) => r.campaign === 'c5')?.visitors).toBe(2);
  });
});

describe('Store', () => {
  function seeded() {
    const store = openStore(':memory:');
    const counters = new Counters();
    counters.add(visit('2026-10-13T03:30:00Z')); // 12.10 по Нью-Йорку
    counters.add(visit('2026-10-13T05:00:00Z')); // 13.10 по Нью-Йорку
    counters.add(visit('2026-10-13T05:10:00Z', { source: 'google', first: false }));
    counters.add(visit('2026-10-13T06:00:00Z', { source: '' }));
    store.add(counters.drain());
    return store;
  }

  it('повторная запись тех же суток и разрезов прибавляется к счётчикам', () => {
    const store = seeded();
    const counters = new Counters();
    counters.add(visit('2026-10-13T05:20:00Z'));
    store.add(counters.drain());
    const day = store.stats({ from: '2026-10-13', to: '2026-10-13', group: 'source', filters: {} });
    expect(day.find((r) => r.value === 'facebook')).toMatchObject({ visitors: 2, visits: 2 }); // 03:30 UTC — ещё 12.10 по Нью-Йорку
  });

  it('по дням (сутки посчитаны при приёме визита); разрез: по убыванию посетителей, «не определено» (null) — в конце', () => {
    const store = seeded();
    expect(store.stats({ from: '2026-10-12', to: '2026-10-13', group: null, filters: {} })).toEqual([
      { day: '2026-10-12', value: null, visitors: 1, visits: 1, bots: 0, trials: 0, trials_started: 0 },
      { day: '2026-10-13', value: null, visitors: 2, visits: 3, bots: 0, trials: 0, trials_started: 0 },
    ]);
    expect(
      store.stats({ from: '2026-10-13', to: '2026-10-13', group: 'source', filters: {} }).map((r) => [r.value, r.visitors, r.visits]),
    ).toEqual([
      ['facebook', 1, 1],
      ['google', 0, 1],
      [null, 1, 1],
    ]);
  });

  it('фильтры: несколько значений — через ИЛИ, none — не определено', () => {
    const store = seeded();
    const total = (filters: object) =>
      store.stats({ from: '2026-10-13', to: '2026-10-13', group: null, filters }).reduce((s, r) => s + r.visits, 0);
    expect(total({ source: ['google'] })).toBe(1);
    expect(total({ source: ['google', 'none'] })).toBe(2);
    expect(total({ source: ['facebook'], country: ['US'] })).toBe(1);
    expect(total({ country: ['SA'] })).toBe(0);
  });

  it('база до разреза «сайт»: счётчики переносятся с пустым сайтом', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'visits-')), 'visits.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE counters (day TEXT NOT NULL, source TEXT NOT NULL, campaign TEXT NOT NULL, ab_test TEXT NOT NULL, ab_segment TEXT NOT NULL,
        variant TEXT NOT NULL, country TEXT NOT NULL, device TEXT NOT NULL, os TEXT NOT NULL,
        visitors INTEGER NOT NULL DEFAULT 0, visits INTEGER NOT NULL DEFAULT 0, bots INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, source, campaign, ab_test, ab_segment, variant, country, device, os)) WITHOUT ROWID;
      INSERT INTO counters VALUES ('2026-10-13', 'facebook', '', '', '', '', 'US', 'mobile', 'ios', 3, 5, 1);
    `);
    old.close();
    const store = openStore(file);
    expect(store.stats({ from: '2026-10-13', to: '2026-10-13', group: 'site', filters: {} })).toEqual([
      { day: '2026-10-13', value: null, visitors: 3, visits: 5, bots: 1, trials: 0, trials_started: 0 },
    ]);
    store.db.close();
    expect(openStore(file).stats({ from: '2026-10-13', to: '2026-10-13', group: null, filters: {} })[0].visits).toBe(5); // второй запуск — без пересборки
  });

  it('база до счётчиков триалов: колонки добавляются, счётчики на месте', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'visits-')), 'visits.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE counters (day TEXT NOT NULL, site TEXT NOT NULL, source TEXT NOT NULL, campaign TEXT NOT NULL, ab_test TEXT NOT NULL,
        ab_segment TEXT NOT NULL, variant TEXT NOT NULL, country TEXT NOT NULL, device TEXT NOT NULL, os TEXT NOT NULL,
        visitors INTEGER NOT NULL DEFAULT 0, visits INTEGER NOT NULL DEFAULT 0, bots INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, site, source, campaign, ab_test, ab_segment, variant, country, device, os)) WITHOUT ROWID;
      INSERT INTO counters VALUES ('2026-10-13', 'a.example', '', '', '', '', '', 'US', 'mobile', 'ios', 3, 5, 1);
    `);
    old.close();
    const store = openStore(file);
    const counters = new Counters();
    counters.add(parseVisit(JSON.stringify({ event: 'trial', site: 'a.example', first_visit: '2026-10-13T16:00:00Z' }), { 'user-agent': IPHONE, 'cf-ipcountry': 'US' }, at('2026-10-14T15:00:00Z'), 'America/New_York')!);
    store.add(counters.drain());
    expect(store.stats({ from: '2026-10-13', to: '2026-10-14', group: 'site', filters: {} })).toEqual([
      { day: '2026-10-13', value: 'a.example', visitors: 3, visits: 5, bots: 1, trials: 1, trials_started: 0 },
      { day: '2026-10-14', value: 'a.example', visitors: 0, visits: 0, bots: 0, trials: 0, trials_started: 1 },
    ]);
  });
});
