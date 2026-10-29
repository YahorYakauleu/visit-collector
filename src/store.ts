import { DatabaseSync } from 'node:sqlite';
import type { CounterRow } from './counters.js';
import { DIMENSIONS, type Dimension, type EventName } from './event.js';

export interface StatsQuery {
  from: string; // первый день (YYYY-MM-DD, местные сутки из TIMEZONE)
  to: string; // последний день включительно
  events: EventName[]; // какие события; пусто — все
  group: Dimension | null; // разрез; null — только по дням
  filters: Partial<Record<Dimension, string[]>>; // значения одного фильтра — через ИЛИ; 'none' — не определено
}

export interface StatsRow {
  day: string;
  event: EventName;
  value: string | null; // значение разреза; null — не определено (или разреза нет)
  count: number;
  bots: number;
}

export type Store = ReturnType<typeof openStore>;

export function openStore(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    -- до событий были жёсткие счётчики визитов и триалов; боевых данных в них не было
    DROP TABLE IF EXISTS counters;
    -- одна строка — сутки, событие и сочетание разрезов; пустая строка в разрезе — не определено
    CREATE TABLE IF NOT EXISTS events (
      day TEXT NOT NULL,
      event TEXT NOT NULL,
      site TEXT NOT NULL,
      source TEXT NOT NULL,
      campaign TEXT NOT NULL,
      ab_test TEXT NOT NULL,
      ab_segment TEXT NOT NULL,
      variant TEXT NOT NULL,
      country TEXT NOT NULL,
      device TEXT NOT NULL,
      os TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      bots INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, event, site, source, campaign, ab_test, ab_segment, variant, country, device, os)
    ) WITHOUT ROWID;
  `);
  const columns = ['day', 'event', ...DIMENSIONS] as const;
  const add = db.prepare(`
    INSERT INTO events (${columns.join(', ')}, count, bots)
    VALUES (${columns.map((c) => `@${c}`).join(', ')}, @count, @bots)
    ON CONFLICT (${columns.join(', ')}) DO UPDATE SET
      count = count + excluded.count,
      bots = bots + excluded.bots
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

    // То же частями, с паузой между ними: запись идёт в том же потоке, что и приём событий,
    // и большая пачка одним куском остановила бы приём на время записи
    async addInChunks(rows: CounterRow[], chunk = 2_000): Promise<void> {
      for (let i = 0; i < rows.length; i += chunk) {
        this.add(rows.slice(i, i + chunk));
        await new Promise((resolve) => setImmediate(resolve));
      }
    },

    // Счётчики по дням, событиям и, если нужно, по разрезу: по убыванию, «не определено» (null) — в конце
    stats(q: StatsQuery): StatsRow[] {
      const params: Record<string, string> = { from: q.from, to: q.to };
      const clauses = ['day >= @from', 'day <= @to'];
      const where = (column: string, values: string[]) => {
        if (values.length === 0) return;
        const named = values.map((v, i) => {
          params[`f_${column}_${i}`] = v === 'none' ? '' : v;
          return `@f_${column}_${i}`;
        });
        clauses.push(`${column} IN (${named.join(', ')})`);
      };
      where('event', q.events);
      for (const dimension of DIMENSIONS) where(dimension, q.filters[dimension] ?? []);
      const value = q.group ?? "''";
      const rows = db
        .prepare(
          `SELECT day, event, ${value} AS value, SUM(count) AS count, SUM(bots) AS bots
           FROM events WHERE ${clauses.join(' AND ')}
           GROUP BY day, event, value ORDER BY day, event, value = '', count DESC, value`,
        )
        .all(params) as unknown as (Omit<StatsRow, 'value'> & { value: string })[];
      return rows.map((r) => ({ ...r, value: r.value === '' ? null : r.value }));
    },
  };
}
