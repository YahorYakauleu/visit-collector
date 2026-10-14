import type { IncomingHttpHeaders } from 'node:http';
import { localDay } from './time.js';

// Визит — показ пейволла. Браузер сам знает, первый ли это визит посетителя (у него ещё не было id),
// поэтому сервер не хранит посетителей поштучно — только счётчики по дням и разрезам.
export const DIMENSIONS = ['source', 'campaign', 'ab_test', 'ab_segment', 'variant', 'country', 'device', 'os'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

// Местные сутки визита и его разрезы; пустая строка — не определено
export type VisitKey = { day: string } & Record<Dimension, string>;

export interface Visit {
  key: VisitKey;
  first: boolean; // первый визит посетителя — это и есть «посетитель» в воронке
  bot: boolean;
}

const MAX_LENGTH = 64;
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|facebookexternalhit|preview|python|curl|wget|httpclient|java\/|go-http/i;

// Тело визита — JSON (из sendBeacon приходит как text/plain, чтобы браузер не делал CORS-preflight):
// { "first": true, "source": "facebook", "campaign": "123", "ab_test": "paywall_v3", "ab_segment": "b", "variant": "v2" }
export function parseVisit(body: string, headers: IncomingHttpHeaders, now: number, timeZone: string): Visit | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const v = data as Record<string, unknown>;
  const userAgent = String(headers['user-agent'] ?? '');
  return {
    key: {
      day: dayAt(now, timeZone),
      source: clean(v.source),
      campaign: clean(v.campaign),
      ab_test: clean(v.ab_test),
      ab_segment: clean(v.ab_segment),
      variant: clean(v.variant),
      country: country(headers),
      device: device(userAgent),
      os: os(userAgent),
    },
    first: v.first === true,
    bot: userAgent === '' || BOT.test(userAgent),
  };
}

// Местные сутки — одни на всю минуту: считать их заново на каждый из тысяч визитов в секунду незачем
let cached = { minute: -1, timeZone: '', day: '' };
function dayAt(now: number, timeZone: string): string {
  const minute = Math.floor(now / 60_000);
  if (cached.minute !== minute || cached.timeZone !== timeZone) cached = { minute, timeZone, day: localDay(minute * 60, timeZone) };
  return cached.day;
}

// Значения из браузера: строка без управляющих символов, не длиннее 64 — иначе разрезов станет слишком много
function clean(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_LENGTH);
}

// Страна — по IP, её проставляет Cloudflare перед сервисом; сам IP не храним
function country(headers: IncomingHttpHeaders): string {
  const raw = String(headers['cf-ipcountry'] ?? '').toUpperCase();
  return /^[A-Z]{2}$/.test(raw) && raw !== 'XX' && raw !== 'T1' ? raw : '';
}

function device(userAgent: string): string {
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(userAgent)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android/i.test(userAgent)) return 'mobile';
  return userAgent ? 'desktop' : '';
}

function os(userAgent: string): string {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'macos';
  if (/Linux|CrOS/i.test(userAgent)) return 'linux';
  return userAgent ? 'other' : '';
}
