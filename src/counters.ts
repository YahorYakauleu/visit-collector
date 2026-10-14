import { DIMENSIONS, type Visit, type VisitKey } from './visit.js';

export interface CounterRow extends VisitKey {
  visitors: number; // первые визиты
  visits: number; // все показы пейволла
  bots: number; // визиты ботов — в посетителей и визиты не входят
  trials: number; // триалы посетителей, впервые пришедших в эти сутки (когорта, окно — TRIAL_WINDOW_DAYS)
  trials_started: number; // триалы, оформленные в эти сутки, — для сверки с платёжными провайдерами
}

// Сколько разных сочетаний разрезов держим до сброса на диск. Сверх — кампания сворачивается в «(other)»:
// так мусорные значения из браузера не раздуют память и базу.
const MAX_KEYS = 200_000;
export const OTHER = '(other)';

// Счётчики в памяти: визит не пишется на диск сразу, а прибавляется к своему часу и разрезам;
// раз в FLUSH_SECONDS всё накопленное уходит в базу одной транзакцией (drain)
export class Counters {
  private buffer = new Map<string, CounterRow>();

  add(visit: Visit): void {
    // триал — это оплата, а не просто показ: считаем и с «ботовым» User-Agent
    if (visit.trial) {
      this.row(visit.key).trials_started++;
      if (visit.trial.cohortDay) this.row({ ...visit.key, day: visit.trial.cohortDay }).trials++;
      return;
    }
    const row = this.row(visit.key);
    if (visit.bot) {
      row.bots++;
    } else {
      row.visits++;
      if (visit.first) row.visitors++;
    }
  }

  private row(visitKey: VisitKey): CounterRow {
    let key = visitKey;
    let id = keyId(key);
    if (!this.buffer.has(id) && this.buffer.size >= MAX_KEYS) {
      key = { ...key, campaign: OTHER };
      id = keyId(key);
    }
    let row = this.buffer.get(id);
    if (!row) {
      row = { ...key, visitors: 0, visits: 0, bots: 0, trials: 0, trials_started: 0 };
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

const keyId = (key: VisitKey) => [key.day, ...DIMENSIONS.map((d) => key[d])].join('\u0001');
