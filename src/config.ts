import { existsSync } from 'node:fs';
import { assertTimeZone } from './time.js';

export interface Config {
  port: number;
  dataDir: string;
  readToken: string; // токен для GET /api/stats — его использует дашборд
  allowedOrigins: string[]; // домены лендингов; пусто — события принимаются с любого (только для локальной разработки)
  timeZone: string; // по какому времени резать сутки — как у Stripe в дашборде
  flushSeconds: number; // как часто счётчики из памяти пишутся на диск
  rateLimitPerMinute: number; // событий с одного IP в минуту, сверх — отбрасываем
}

type Env = Record<string, string | undefined>;

export function loadEnvFile(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(env: Env = process.env): Config {
  const readToken = env.READ_TOKEN?.trim();
  if (!readToken) throw new Error('Не задана переменная READ_TOKEN');
  const timeZone = env.TIMEZONE?.trim() || 'America/New_York';
  try {
    assertTimeZone(timeZone);
  } catch {
    throw new Error(`TIMEZONE: неизвестный часовой пояс "${timeZone}", пример — America/New_York`);
  }
  return {
    port: positiveInt(env, 'PORT', 3000),
    dataDir: env.DATA_DIR?.trim() || './data',
    readToken,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
    timeZone,
    flushSeconds: positiveInt(env, 'FLUSH_SECONDS', 60),
    rateLimitPerMinute: positiveInt(env, 'RATE_LIMIT_PER_MINUTE', 60),
  };
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} должен быть положительным целым числом`);
  return value;
}
