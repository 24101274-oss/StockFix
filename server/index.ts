import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { buildApp } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const app = await buildApp({
  dataDir: resolve(process.env.DATA_DIR ?? './data/demo-db'),
  serveStatic: true,
  allowedOrigins: ['http://localhost:5174', 'http://127.0.0.1:5174', 'http://localhost:3341', 'http://127.0.0.1:3341'],
  // La copia académica solo consulta datos locales; no usa servicios externos.
  lookup: { token: '', dniEnabled: false, rucEnabled: false },
});
const port = Number(process.env.PORT ?? 3341);
await app.listen({ port, host: process.env.API_HOST ?? '127.0.0.1' });
console.log(`StockFix API disponible en http://${process.env.API_HOST ?? '127.0.0.1'}:${port}. Emisión tributaria desactivada.`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await app.close(); process.exit(0); });
