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
    -- одна строка — сутки, событие и сочетание разрезов. Разрезы — JSON с определёнными значениями в порядке DIMENSIONS:
    -- новый разрез не требует миграции, у старых строк его просто нет (не определено)
    CREATE TABLE IF NOT EXISTS events (
      day TEXT NOT NULL,
      event TEXT NOT NULL,
      dims TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      bots INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, event, dims)
    ) WITHOUT ROWID;
  `);
  const add = db.prepare(`
    INSERT INTO events (day, event, dims, count, bots) VALUES (@day, @event, @dims, @count, @bots)
    ON CONFLICT (day, event, dims) DO UPDATE SET
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
        for (const row of rows) add.run({ day: row.day, event: row.event, dims: dims(row), count: row.count, bots: row.bots });
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
      const placeholders = (prefix: string, values: string[]) =>
        values
          .map((value, i) => {
            params[`${prefix}_${i}`] = value;
            return `@${prefix}_${i}`;
          })
          .join(', ');
      const clauses = ['day >= @from', 'day <= @to'];
      if (q.events.length) clauses.push(`event IN (${placeholders('event', q.events)})`);
      for (const dimension of DIMENSIONS) {
        const values = q.filters[dimension] ?? [];
        if (values.length === 0) continue;
        const column = dimensionSql(dimension);
        const known = values.filter((v) => v !== 'none');
        const any: string[] = [];
        if (known.length) any.push(`${column} IN (${placeholders(dimension, known)})`);
        if (values.includes('none')) any.push(`${column} IS NULL`);
        clauses.push(`(${any.join(' OR ')})`);
      }
      const value = q.group ? dimensionSql(q.group) : 'NULL';
      return db
        .prepare(
          `SELECT day, event, ${value} AS value, SUM(count) AS count, SUM(bots) AS bots
           FROM events WHERE ${clauses.join(' AND ')}
           GROUP BY day, event, value ORDER BY day, event, value IS NULL, count DESC, value`,
        )
        .all(params) as unknown as StatsRow[];
    },
  };
}

// Разрезы строки в JSON: только определённые, в порядке DIMENSIONS — одинаковые сочетания дают одинаковую строку
function dims(row: CounterRow): string {
  return JSON.stringify(Object.fromEntries(DIMENSIONS.filter((d) => row[d] !== '').map((d) => [d, row[d]])));
}

// Имя разреза — из DIMENSIONS, не из запроса, поэтому подставлять в SQL безопасно
const dimensionSql = (dimension: Dimension) => `json_extract(dims, '$.${dimension}')`;
