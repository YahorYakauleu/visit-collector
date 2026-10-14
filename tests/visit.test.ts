import { describe, expect, it } from 'vitest';
import { parseVisit } from '../src/visit.js';

const NOW = Date.parse('2026-10-14T15:42:10Z');
const NY = 'America/New_York';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const body = (p: object) => JSON.stringify({ first: true, source: 'facebook', campaign: '123', ab_test: 'paywall_v3', ab_segment: 'b', variant: 'v2', ...p });

describe('parseVisit', () => {
  it('визит: местные сутки, разрезы из тела, страна от Cloudflare, устройство и ОС из User-Agent', () => {
    expect(parseVisit(body({}), { 'user-agent': IPHONE, 'cf-ipcountry': 'us' }, NOW, NY)).toEqual({
      key: {
        day: '2026-10-14',
        source: 'facebook',
        campaign: '123',
        ab_test: 'paywall_v3',
        ab_segment: 'b',
        variant: 'v2',
        country: 'US',
        device: 'mobile',
        os: 'ios',
      },
      first: true,
      bot: false,
    });
  });

  it('сутки — по часовому поясу: 02:00 UTC — ещё вчера по Нью-Йорку', () => {
    expect(parseVisit(body({}), { 'user-agent': IPHONE }, Date.parse('2026-10-14T02:00:00Z'), NY)!.key.day).toBe('2026-10-13');
    expect(parseVisit(body({}), { 'user-agent': IPHONE }, Date.parse('2026-10-14T02:00:00Z'), 'UTC')!.key.day).toBe('2026-10-14');
  });

  it('пустые и мусорные значения: не строка — не определено, управляющие символы вырезаются, длина ≤ 64', () => {
    const visit = parseVisit(body({ source: { x: 1 }, campaign: 42, ab_test: ' a\u0000b\n ', variant: 'x'.repeat(200), first: 'yes' }), { 'user-agent': IPHONE }, NOW, NY)!;
    expect(visit.key).toMatchObject({ source: '', campaign: '42', ab_test: 'ab', country: '' });
    expect(visit.key.variant).toHaveLength(64);
    expect(visit.first).toBe(false); // только true — первый визит
  });

  it('устройства и ОС; страна XX и T1 (Tor) — не определена', () => {
    const ua = (userAgent: string) => parseVisit(body({}), { 'user-agent': userAgent, 'cf-ipcountry': 'T1' }, NOW, NY)!.key;
    expect(ua('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Mobile Safari/537.36')).toMatchObject({ device: 'mobile', os: 'android', country: '' });
    expect(ua('Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Safari/537.36')).toMatchObject({ device: 'tablet', os: 'android' });
    expect(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36')).toMatchObject({ device: 'desktop', os: 'windows' });
    expect(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15')).toMatchObject({ device: 'desktop', os: 'macos' });
  });

  it('боты: известные User-Agent и пустой', () => {
    expect(parseVisit(body({}), { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }, NOW, NY)!.bot).toBe(true);
    expect(parseVisit(body({}), { 'user-agent': 'Mozilla/5.0 HeadlessChrome/120' }, NOW, NY)!.bot).toBe(true);
    expect(parseVisit(body({}), {}, NOW, NY)!.bot).toBe(true);
  });

  it('не JSON-объект — не визит', () => {
    expect(parseVisit('not json', {}, NOW, NY)).toBeNull();
    expect(parseVisit('[1,2]', {}, NOW, NY)).toBeNull();
    expect(parseVisit('null', {}, NOW, NY)).toBeNull();
  });
});
