import { describe, expect, it } from 'vitest';
import { parseEvent } from '../src/event.js';

const NOW = Date.parse('2026-10-14T15:42:10Z');
const NY = 'America/New_York';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const body = (p: object) => JSON.stringify({ event: 'visit', site: 'pay.toggle.example', path: '/sport', ...p });

describe('parseEvent', () => {
  it('событие: местные сутки, имя, сайт и путь из тела, страна от Cloudflare, устройство и ОС из User-Agent', () => {
    expect(parseEvent(body({}), { 'user-agent': IPHONE, 'cf-ipcountry': 'us' }, NOW, NY)).toEqual({
      key: {
        day: '2026-10-14',
        event: 'visit',
        site: 'pay.toggle.example',
        path: '/sport',
        country: 'US',
        device: 'mobile',
        os: 'ios',
        browser: 'webview', // у IPHONE в тестах нет «Safari/» — так выглядит встроенное окно приложения
        account: '',
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

  it('путь: без query-строки и #, без завершающего /, можно полным адресом; не строка — не определён, длина ≤ 64', () => {
    const path = (value: unknown) => parseEvent(body({ path: value }), { 'user-agent': IPHONE }, NOW, NY)!.key.path;
    expect(path('/sport?utm_source=fb&fbclid=abc#/plans')).toBe('/sport');
    expect(path('/sport/')).toBe('/sport');
    expect(path('/')).toBe('/');
    expect(path('https://pay.toggle.example/movies/?cpp=video')).toBe('/movies');
    expect(path('/a b')).toBe('/a%20b');
    expect(path(`/${'x'.repeat(200)}`)).toHaveLength(64);
    expect(path({ x: 1 })).toBe('');
    expect(path(undefined)).toBe('');
  });

  it('другие поля тела игнорируются: страна, устройство и ОС — только из заголовков', () => {
    const event = parseEvent(body({ country: 'SA', device: 'tv', utm_source: 'fb' }), { 'user-agent': IPHONE }, NOW, NY)!;
    expect(event.key).toEqual({ day: '2026-10-14', event: 'visit', site: 'pay.toggle.example', path: '/sport', country: '', device: 'mobile', os: 'ios', browser: 'webview', account: '' });
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

  it('браузер: встроенные браузеры соцсетей, WebView, Chrome на iOS и браузеры на основе Chrome — раньше Safari и Chrome', () => {
    const browser = (userAgent: string) => parseEvent(body({}), { 'user-agent': userAgent }, NOW, NY)!.key.browser;
    const iosSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    expect(browser(iosSafari)).toBe('safari');
    expect(browser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1')).toBe('chrome');
    expect(browser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/485.0.0.40.109;FBBV/650000000;FBDV/iPhone15,2]')).toBe('facebook');
    expect(browser('Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/485.0.0.40.109;]')).toBe('facebook');
    expect(browser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.40.97 (iPhone15,2; iOS 18_0; en_US)')).toBe('instagram');
    expect(browser('Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 trill_370103 BytedanceWebview/d8a21c6')).toBe('tiktok');
    expect(browser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/13.10.0.40 (like Safari/8618.1.15.10.15)')).toBe('snapchat');
    expect(browser('Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36')).toBe('webview');
    expect(browser('Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36')).toBe('samsung');
    expect(browser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toBe('edge');
    expect(browser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0')).toBe('opera');
    expect(browser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36')).toBe('yandex');
    expect(browser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('firefox');
    expect(browser('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36')).toBe('chrome');
    expect(browser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('safari');
    expect(browser('SomethingElse/1.0')).toBe('other');
    expect(parseEvent(body({}), {}, NOW, NY)!.key.browser).toBe(''); // без User-Agent — не определён
  });

  it('аккаунт пейволла — как в дашборде: stripe:<аккаунт> или solidgate; другое — не определён', () => {
    const account = (value: unknown) => parseEvent(body({ account: value }), { 'user-agent': IPHONE }, NOW, NY)!.key.account;
    expect(account('stripe:org')).toBe('stripe:org');
    expect(account('Stripe:Corp')).toBe('stripe:corp');
    expect(account('solidgate')).toBe('solidgate');
    expect(account('solidgate:sg')).toBe('');
    expect(account('org')).toBe('');
    expect(account('stripe:<script>')).toBe('');
    expect(account(undefined)).toBe('');
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
