// Нагрузочный тест сборщика: node scripts/loadtest.mjs [--url http://127.0.0.1:3000] [--connections 100] [--seconds 20] [--rate 400]
// Без --rate — максимальная пропускная способность; с --rate — ровный поток N визитов в секунду и задержки на нём.
// Не запускать против продового сборщика: визиты попадут в счётчики.
import http from 'node:http';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((a) => a.trim().split(/\s+/)));
const url = new URL(args.url ?? 'http://127.0.0.1:3000');
const connections = Number(args.connections ?? 100);
const seconds = Number(args.seconds ?? 20);
const rate = args.rate ? Number(args.rate) : null;

const sources = ['facebook', 'google', 'tiktok', 'push', 'native', 'organic'];
const countries = ['US', 'SA', 'FR', 'ES', 'GB', 'DE', 'MX', 'BR', 'IN', 'RO', 'IT', 'GE'];
const agents = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const agent = new http.Agent({ keepAlive: true, maxSockets: connections });

let sent = 0;
let ok = 0;
const errors = {};
const latencies = [];
const started = performance.now();
const end = started + seconds * 1000;

function visit() {
  const body = JSON.stringify({
    first: Math.random() < 0.8,
    source: pick(sources),
    campaign: `c${Math.floor(Math.random() * 300)}`,
    ab_test: 'paywall_v3',
    ab_segment: pick(['a', 'b', 'c']),
    variant: `v${Math.floor(Math.random() * 6)}`,
  });
  const headers = {
    'content-type': 'text/plain',
    'content-length': Buffer.byteLength(body),
    'user-agent': pick(agents),
    'cf-ipcountry': pick(countries),
    'x-forwarded-for': `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
  };
  const t = performance.now();
  return new Promise((resolve) => {
    const req = http.request({ host: url.hostname, port: url.port, path: '/v1/visit', method: 'POST', agent, headers }, (res) => {
      res.resume();
      res.on('end', () => {
        latencies.push(performance.now() - t);
        if (res.statusCode === 204) ok++;
        else errors[res.statusCode] = (errors[res.statusCode] ?? 0) + 1;
        resolve();
      });
    });
    req.on('error', (e) => {
      errors[e.code] = (errors[e.code] ?? 0) + 1;
      resolve();
    });
    req.end(body);
  });
}

async function worker() {
  while (performance.now() < end) {
    if (rate) {
      // ровный поток: у каждого визита своё время отправки
      const slot = started + (sent / rate) * 1000;
      if (slot > end) return;
      sent++;
      const wait = slot - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    } else {
      sent++;
    }
    await visit();
  }
}

await Promise.all(Array.from({ length: connections }, worker));
agent.destroy();
latencies.sort((a, b) => a - b);
const p = (q) => (latencies.length ? +latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))].toFixed(1) : null);
const elapsed = (performance.now() - started) / 1000;
console.log(
  JSON.stringify({
    mode: rate ? `ровно ${rate}/с` : 'максимум',
    seconds: +elapsed.toFixed(1),
    accepted_per_second: Math.round(ok / elapsed),
    accepted: ok,
    errors,
    latency_ms: { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: p(1) },
  }),
);
