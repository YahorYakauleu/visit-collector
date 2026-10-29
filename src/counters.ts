import { DIMENSIONS, type CollectedEvent, type EventKey } from './event.js';

export interface CounterRow extends EventKey {
  count: number; // события от людей
  bots: number; // события ботов — в count не входят
}

// Сколько разных сочетаний разрезов держим до сброса на диск. Сверх — путь сворачивается в «(other)»:
// так мусорные значения из браузера не раздуют память и базу.
const MAX_KEYS = 200_000;
export const OTHER = '(other)';

// Счётчики в памяти: событие не пишется на диск сразу, а прибавляется к своим суткам и разрезам;
// раз в FLUSH_SECONDS всё накопленное уходит в базу одной транзакцией (drain)
export class Counters {
  private buffer = new Map<string, CounterRow>();

  add(event: CollectedEvent): void {
    const row = this.row(event.key);
    if (event.bot) row.bots++;
    else row.count++;
  }

  private row(eventKey: EventKey): CounterRow {
    let key = eventKey;
    let id = keyId(key);
    if (!this.buffer.has(id) && this.buffer.size >= MAX_KEYS) {
      key = { ...key, path: OTHER };
      id = keyId(key);
    }
    let row = this.buffer.get(id);
    if (!row) {
      row = { ...key, count: 0, bots: 0 };
      this.buffer.set(id, row);
    }
    return row;
  }

  get size(): number {
    return this.buffer.size;
  }

  // Забрать накопленное и начать заново
  drain(): CounterRow[] {
    const rows = [...this.buffer.values()];
    this.buffer = new Map();
    return rows;
  }
}

const keyId = (key: EventKey) => [key.day, key.event, ...DIMENSIONS.map((d) => key[d])].join('\u0001');
