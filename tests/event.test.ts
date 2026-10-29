import { describe, expect, it } from 'vitest';
import { parseEvent } from '../src/event.js';

const NOW = Date.parse('2026-10-14T15:42:10Z');
const NY = 'America/New_York';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const body = (p: object) => JSON.stringify({ event: 'visit', site: 'pay.toggle.example', source: 'facebook', campaign: '123', ab_test: 'paywall_v3', ab_segment: 'b', variant: 'v2', ...p });

describe('parseEvent', () => {
  it('событие: местные сутки, имя, разрезы из тела, страна от Cloudflare, устройство и ОС из User-Agent', () => {
    expect(parseEvent(body({}), { 'user-agent': IPHONE, 'cf-ipcountry': 'us' }, NOW, NY)).toEqual({
      key: {
        day: '2026-10-14',
        event: 'visit',
        site: 'pay.toggle.example',
        source: 'facebook',
        campaign: '123',
        ab_test: 'paywall_v3',
        ab_segment: 'b',
        variant: 'v2',
        country: 'US',
        device: 'mobile',
        os: 'ios',
      },
      bot: false,
    });
  });

  it('имя не из списка EVENTS или без имени — не событие', () => {
    expect(parseEvent(body({ event: 'trial' }), { 'user-agent': IPHONE }, NOW, NY)).toBeNull();
    expect(parseEvent(body({ event: undefined }), { 'user-agent': IPHONE }, NOW, NY)).toBeNull();
    expect(parseEvent(body({ event: ['visit'] }), { 'user-agent': IPHONE }, NOW, NY)).toBeNull();
  });

  it('сутки — по часовому поясу: 02:00 UTC — ещё вчера по Нью-Йорку', () => {
    expect(parseEvent(body({}), { 'user-agent': IPHONE }, Date.parse('2026-10-14T02:00:00Z'), NY)!.key.day).toBe('2026-10-13');
    expect(parseEvent(body({}), { 'user-agent': IPHONE }, Date.parse('2026-10-14T02:00:00Z'), 'UTC')!.key.day).toBe('2026-10-14');
  });

  it('пустые и мусорные значения: не строка — не определено, управляющие символы вырезаются, длина ≤ 64', () => {
    const event = parseEvent(body({ source: { x: 1 }, campaign: 42, ab_test: ' a\u0000b\n ', variant: 'x'.repeat(200) }), { 'user-agent': IPHONE }, NOW, NY)!;
    expect(event.key).toMatchObject({ source: '', campaign: '42', ab_test: 'ab', country: '' });
    expect(event.key.variant).toHaveLength(64);
  });

  it('сайт — домен: из события (можно полным адресом), иначе из Origin; не адрес — не определён', () => {
    const site = (value: unknown, origin?: string) =>
      parseEvent(body({ site: value }), { 'user-agent': IPHONE, ...(origin && { origin }) }, NOW, NY)!.key.site;
    expect(site('Pay.Toggle.Example')).toBe('pay.toggle.example');
    expect(site('https://pay.toggle.example/path?utm_source=fb#/plans')).toBe('pay.toggle.example');
    expect(site('localhost:5173')).toBe('localhost:5173');
    expect(site(undefined, 'https://react.toggle.example')).toBe('react.toggle.example');
    expect(site('a b')).toBe('');
    expect(site(undefined)).toBe('');
  });

  it('устройства и ОС; страна XX и T1 (Tor) — не определена', () => {
    const ua = (userAgent: string) => parseEvent(body({}), { 'user-agent': userAgent, 'cf-ipcountry': 'T1' }, NOW, NY)!.key;
    expect(ua('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Mobile Safari/537.36')).toMatchObject({ device: 'mobile', os: 'android', country: '' });
    expect(ua('Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Safari/537.36')).toMatchObject({ device: 'tablet', os: 'android' });
    expect(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36')).toMatchObject({ device: 'desktop', os: 'windows' });
    expect(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15')).toMatchObject({ device: 'desktop', os: 'macos' });
  });

  it('боты: известные User-Agent и пустой', () => {
    expect(parseEvent(body({}), { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }, NOW, NY)!.bot).toBe(true);
    expect(parseEvent(body({}), { 'user-agent': 'Mozilla/5.0 HeadlessChrome/120' }, NOW, NY)!.bot).toBe(true);
    expect(parseEvent(body({}), {}, NOW, NY)!.bot).toBe(true);
  });

  it('не JSON-объект — не событие', () => {
    expect(parseEvent('not json', {}, NOW, NY)).toBeNull();
    expect(parseEvent('[1,2]', {}, NOW, NY)).toBeNull();
    expect(parseEvent('null', {}, NOW, NY)).toBeNull();
  });
});
