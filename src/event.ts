import type { IncomingHttpHeaders } from 'node:http';
import { localDay } from './time.js';

// События с лендинга. Сборщик не хранит их поштучно — только счётчики по суткам, событию и разрезам.
// Новое событие — строка в EVENTS: имена не из списка отклоняются, иначе мусорные имена раздули бы базу.
export const EVENTS = [
  'visit', // уникальный посетитель пейволла — лендинг отправляет его один раз на браузер
] as const;
export type EventName = (typeof EVENTS)[number];

// Разрезы: что присылает лендинг (site, path) и что сборщик определяет сам (country, device, os, browser).
// Новый разрез — строка здесь: в базе разрезы лежат одним полем, колонки и миграции не нужны
export const DIMENSIONS = ['site', 'path', 'country', 'device', 'os', 'browser'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

// Местные сутки, событие и разрезы; пустая строка в разрезе — не определено
export type EventKey = { day: string; event: EventName } & Record<Dimension, string>;

export interface CollectedEvent {
  key: EventKey;
  bot: boolean;
}

const MAX_LENGTH = 64;
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|facebookexternalhit|preview|python|curl|wget|httpclient|java\/|go-http/i;

export const isEventName = (value: unknown): value is EventName => (EVENTS as readonly unknown[]).includes(value);

// Тело — JSON (из sendBeacon приходит как text/plain, чтобы браузер не делал CORS-preflight):
// { "event": "visit", "site": "example.com", "path": "/sport" }; другие поля игнорируются
export function parseEvent(body: string, headers: IncomingHttpHeaders, now: number, timeZone: string): CollectedEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const v = data as Record<string, unknown>;
  if (!isEventName(v.event)) return null;
  const userAgent = String(headers['user-agent'] ?? '');
  return {
    key: {
      day: dayAt(now, timeZone),
      event: v.event,
      site: site(v.site, headers.origin),
      path: path(v.path),
      country: country(headers),
      device: device(userAgent),
      os: os(userAgent),
      browser: browser(userAgent),
    },
    bot: userAgent === '' || BOT.test(userAgent),
  };
}

// Местные сутки — одни на всю минуту: считать их заново на каждое из тысяч событий в секунду незачем
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

// Сайт — домен лендинга: из события, иначе из заголовка Origin, который ставит браузер. Принимаем и полный адрес
function site(value: unknown, origin: string | undefined): string {
  const raw = clean(value) || origin || '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).host.toLowerCase();
  } catch {
    return '';
  }
}

// Путь страницы без query-строки и #: параметры в адресе (fbclid, gclid…) почти у каждого визита свои и раздули бы базу.
// Принимаем и полный адрес; завершающий / отбрасываем, чтобы /sport и /sport/ были одним путём
function path(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const pathname = new URL(value, 'https://landing').pathname;
    return clean(pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname);
  } catch {
    return '';
  }
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

// Браузер. Встроенные браузеры соцсетей — отдельно: реклама открывает пейволл внутри приложения, а там иначе работают
// Apple Pay и Google Pay. Прочие встроенные окна (Telegram и др.) себя не называют — они «webview».
// Порядок важен: Chrome на iOS и браузеры на основе Chrome тоже пишут Safari и Chrome
const BROWSERS: [string, RegExp][] = [
  ['facebook', /FBAN|FBAV|FB_IAB|FBIOS|FB4A/],
  ['instagram', /Instagram/],
  ['tiktok', /BytedanceWebview|musical_ly|TikTok/i],
  ['snapchat', /Snapchat/],
  ['webview', /; wv\)/], // WebView на Android
  ['samsung', /SamsungBrowser/],
  ['edge', /Edg(e|A|iOS)?\//],
  ['opera', /OPR\/|OPiOS|Opera/],
  ['yandex', /YaBrowser/],
  ['firefox', /Firefox\/|FxiOS/],
  ['chrome', /Chrome\/|CriOS/],
];
function browser(userAgent: string): string {
  if (!userAgent) return '';
  const known = BROWSERS.find(([, pattern]) => pattern.test(userAgent));
  if (known) return known[0];
  // на iOS все браузеры — WebKit; у встроенного окна приложения нет «Safari/»
  if (/iPhone|iPad|iPod/.test(userAgent)) return /Safari\//.test(userAgent) ? 'safari' : 'webview';
  if (/Safari\//.test(userAgent)) return 'safari';
  return 'other';
}
