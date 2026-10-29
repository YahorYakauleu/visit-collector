import { createHash, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Config } from './config.js';
import type { Counters } from './counters.js';
import type { Store } from './store.js';
import { DIMENSIONS, EVENTS, isEventName, parseEvent, type Dimension } from './event.js';

const MAX_BODY = 2_048;
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

interface Deps {
  config: Config;
  counters: Counters;
  store: Store;
  now?: () => number;
}

// Без фреймворка: события идут потоком (сотни в секунду), каждый лишний слой на счету
export function createServer({ config, counters, store, now = Date.now }: Deps) {
  // Ограничение частоты по IP: счётчик за текущую минуту, раз в минуту обнуляется целиком
  let minute = 0;
  let hits = new Map<string, number>();
  const overLimit = (ip: string) => {
    const current = Math.floor(now() / 60_000);
    if (current !== minute) {
      minute = current;
      hits = new Map();
    }
    const count = (hits.get(ip) ?? 0) + 1;
    hits.set(ip, count);
    return count > config.rateLimitPerMinute;
  };

  const tokenHash = sha256(`Bearer ${config.readToken}`);

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://collector');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, 'ok');
    if (url.pathname === '/v1/events') return collect(req, res);
    if (req.method === 'GET' && url.pathname === '/api/stats') return stats(req, res, url);
    send(res, 404, 'not found');
  });

  // Событие с лендинга. CORS — только для своих доменов; sendBeacon шлёт text/plain, без preflight
  function collect(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin?.replace(/\/$/, '');
    if (origin && config.allowedOrigins.length && !config.allowedOrigins.includes(origin)) return send(res, 403, 'origin');
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
      return send(res, 204);
    }
    if (req.method !== 'POST') return send(res, 405, 'method');
    if (overLimit(clientIp(req))) return send(res, 429, 'rate');

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY && !res.headersSent) {
        send(res, 413, 'too large');
        req.destroy(); // дальше не читаем
      }
    });
    req.on('end', () => {
      if (res.headersSent) return;
      const parsed = parseEvent(body, req.headers, now(), config.timeZone);
      if (!parsed) return send(res, 400, `bad event: ${EVENTS.join('|')}`);
      counters.add(parsed);
      send(res, 204);
    });
  }

  // Цифры для дашборда: ?from=YYYY-MM-DD&to=YYYY-MM-DD&event=visit&group=path&country=US&country=SA (сутки — из TIMEZONE)
  function stats(req: IncomingMessage, res: ServerResponse, url: URL) {
    const given = sha256(String(req.headers.authorization ?? ''));
    if (!timingSafeEqual(given, tokenHash)) return send(res, 401, 'token');
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    const group = url.searchParams.get('group');
    if (!DAY_FORMAT.test(from) || !DAY_FORMAT.test(to) || from > to) return send(res, 400, 'from/to: YYYY-MM-DD');
    if (group && !(DIMENSIONS as readonly string[]).includes(group)) return send(res, 400, `group: ${DIMENSIONS.join('|')}`);
    const events = url.searchParams.getAll('event');
    if (!events.every(isEventName)) return send(res, 400, `event: ${EVENTS.join('|')}`);
    const filters: Partial<Record<Dimension, string[]>> = {};
    for (const dimension of DIMENSIONS) {
      const values = url.searchParams.getAll(dimension).filter(Boolean);
      if (values.length) filters[dimension] = values;
    }
    const rows = store.stats({ from, to, events, group: (group as Dimension | null) || null, filters });
    send(res, 200, JSON.stringify({ from, to, time_zone: config.timeZone, group, rows }), 'application/json');
  }
}

// За Render и Cloudflare настоящий IP — в заголовках прокси
function clientIp(req: IncomingMessage): string {
  const forwarded = String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '';
}

function send(res: ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8') {
  res.writeHead(status, body ? { 'Content-Type': type } : {});
  res.end(body);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();
