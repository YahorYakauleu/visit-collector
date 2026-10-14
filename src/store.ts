import { DatabaseSync } from 'node:sqlite';
import type { CounterRow } from './counters.js';
import { DIMENSIONS, type Dimension } from './visit.js';

export interface StatsQuery {
  from: string; // первый день (YYYY-MM-DD, местные сутки из TIMEZONE)
  to: string; // последний день включительно
  group: Dimension | null; // разрез; null — только по дням
  filters: Partial<Record<Dimension, string[]>>; // значения одного фильтра — через ИЛИ; 'none' — не определено
}

export interface StatsRow {
  day: string;
  value: string | null; // значение разреза; null — не определено (или разреза нет)
  visitors: number;
  visits: number;
  bots: number;
  trials: number; // триалы когорты этих суток
  trials_started: number; // триалы, оформленные в эти сутки
}

export type Store = ReturnType<typeof openStore>;

export function openStore(file: string) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  // База до разреза «сайт»: первичный ключ не поменять, поэтому таблицу пересобираем, а старые счётчики переносим с пустым сайтом
  const before = (db.prepare('PRAGMA table_info(counters)').all() as { name: string }[]).map((c) => c.name);
  const withoutSite = before.length > 0 && !before.includes('site');
  db.exec('BEGIN');
  if (withoutSite) db.exec('ALTER TABLE counters RENAME TO counters_without_site');
  db.exec(`
    -- одна строка — сутки и сочетание разрезов; пустая строка в разрезе — не определено
    CREATE TABLE IF NOT EXISTS counters (
      day TEXT NOT NULL,
      site TEXT NOT NULL,
      source TEXT NOT NULL,
      campaign TEXT NOT NULL,
      ab_test TEXT NOT NULL,
      ab_segment TEXT NOT NULL,
      variant TEXT NOT NULL,
      country TEXT NOT NULL,
      device TEXT NOT NULL,
      os TEXT NOT NULL,
      visitors INTEGER NOT NULL DEFAULT 0,
      visits INTEGER NOT NULL DEFAULT 0,
      bots INTEGER NOT NULL DEFAULT 0,
      trials INTEGER NOT NULL DEFAULT 0,
      trials_started INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, site, source, campaign, ab_test, ab_segment, variant, country, device, os)
    ) WITHOUT ROWID;
  `);
  if (withoutSite) {
    const old = before.join(', ');
    db.exec(`INSERT INTO counters (${old}, site) SELECT ${old}, '' FROM counters_without_site; DROP TABLE counters_without_site;`);
  } else if (before.length > 0 && !before.includes('trials')) {
    // база до счётчиков триалов: колонки просто добавляются
    db.exec('ALTER TABLE counters ADD COLUMN trials INTEGER NOT NULL DEFAULT 0; ALTER TABLE counters ADD COLUMN trials_started INTEGER NOT NULL DEFAULT 0;');
  }
  db.exec('COMMIT');
  const columns = ['day', ...DIMENSIONS] as const;
  const add = db.prepare(`
    INSERT INTO counters (${columns.join(', ')}, visitors, visits, bots, trials, trials_started)
    VALUES (${columns.map((c) => `@${c}`).join(', ')}, @visitors, @visits, @bots, @trials, @trials_started)
    ON CONFLICT (${columns.join(', ')}) DO UPDATE SET
      visitors = visitors + excluded.visitors,
      visits = visits + excluded.visits,
      bots = bots + excluded.bots,
      trials = trials + excluded.trials,
      trials_started = trials_started + excluded.trials_started
  `);

  return {
    db,

    // Прибавить пачку счётчиков одной транзакцией
    add(rows: CounterRow[]): void {
      if (rows.length === 0) return;
      db.exec('BEGIN');
      try {
        for (const row of rows) add.run({ ...row });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    // То же частями, с паузой между ними: запись идёт в том же потоке, что и приём визитов,
    // и большая пачка одним куском остановила бы приём на время записи
    async addInChunks(rows: CounterRow[], chunk = 2_000): Promise<void> {
      for (let i = 0; i < rows.length; i += chunk) {
        this.add(rows.slice(i, i + chunk));
        await new Promise((resolve) => setImmediate(resolve));
      }
    },

    // Посетители, визиты и триалы по дням и, если нужно, по разрезу: по убыванию посетителей, «не определено» (null) — в конце
    stats(q: StatsQuery): StatsRow[] {
      const params: Record<string, string> = { from: q.from, to: q.to };
      const clauses = ['day >= @from', 'day <= @to'];
      for (const dimension of DIMENSIONS) {
        const values = q.filters[dimension] ?? [];
        if (values.length === 0) continue;
        const named = values.map((v, i) => {
          params[`f_${dimension}_${i}`] = v === 'none' ? '' : v;
          return `@f_${dimension}_${i}`;
        });
        clauses.push(`${dimension} IN (${named.join(', ')})`);
      }
      const value = q.group ?? "''";
      const rows = db
        .prepare(
          `SELECT day, ${value} AS value, SUM(visitors) AS visitors, SUM(visits) AS visits, SUM(bots) AS bots,
             SUM(trials) AS trials, SUM(trials_started) AS trials_started
           FROM counters WHERE ${clauses.join(' AND ')}
           GROUP BY day, value ORDER BY day, value = '', visitors DESC, value`,
        )
        .all(params) as unknown as (Omit<StatsRow, 'value'> & { value: string })[];
      return rows.map((r) => ({ ...r, value: r.value === '' ? null : r.value }));
    },
  };
}
