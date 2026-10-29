// Календарные дни в часовом поясе дашборда. День — строка YYYY-MM-DD, момент времени — unix-секунды.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// Бросает RangeError на неизвестном часовом поясе
export function assertTimeZone(timeZone: string): void {
  formatter(timeZone);
}

function wallClock(ts: number, timeZone: string) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

export function localDay(ts: number, timeZone: string): string {
  const w = wallClock(ts, timeZone);
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}
