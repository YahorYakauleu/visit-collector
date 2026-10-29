import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, loadEnvFile } from './config.js';
import { Counters } from './counters.js';
import { createServer } from './server.js';
import { openStore } from './store.js';

loadEnvFile();
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const store = openStore(path.join(config.dataDir, 'visits.sqlite'));
const counters = new Counters();

// Счётчики из памяти — на диск раз в FLUSH_SECONDS и при остановке: при перезапуске теряется не больше этого интервала
const flush = async () => {
  const rows = counters.drain();
  try {
    await store.addInChunks(rows);
  } catch (error) {
    console.error(`не удалось записать ${rows.length} строк счётчиков:`, error);
  }
};
const timer = setInterval(() => void flush(), config.flushSeconds * 1000);

const server = createServer({ config, counters, store });
// Балансировщик Render держит соединение дольше 5 секунд (по умолчанию в Node) — иначе редкие 502
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(config.port, () => {
  console.log(`Сборщик визитов: http://localhost:${config.port}`);
  if (!config.allowedOrigins.length) console.warn('ALLOWED_ORIGINS не задан — события принимаются с любого домена');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    server.close();
    store.add(counters.drain()); // при остановке — одним куском, ждать некого
    process.exit(0);
  });
}
