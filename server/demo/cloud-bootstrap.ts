import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { sql, eq } from 'drizzle-orm';
import { openDatabase, STOCKFIX_WRITE_LOCK } from '../database.js';
import { buildApp } from '../app.js';
import { generateSyntheticDataset } from './dataset.js';
import * as schema from '../schema.js';

await mkdir('tmp/cloud', { recursive: true });
process.loadEnvFile('.env.local');
if (!process.env.DATABASE_URL) throw new Error('Falta la conexiÃ³n de la base provisionada.');
const origin = 'https://stockfix-24101274.vercel.app';
const credentialsFile = 'tmp/cloud/credentials.json';
const credentials = existsSync(credentialsFile) ? JSON.parse(await readFile(credentialsFile, 'utf8')) : {
  admin: randomBytes(20).toString('base64url'), cashier: randomBytes(20).toString('base64url'), origin,
};
await writeFile(credentialsFile, JSON.stringify(credentials, null, 2));
await writeFile('tmp/cloud/accesos-stockfix.txt', `StockFix publicado\n${origin}\n\nAdministrador\nCorreo: admin@stockfix.local\nClave: ${credentials.admin}\n\nCajero\nCorreo: cajero@stockfix.local\nClave: ${credentials.cashier}\n\nAccesos privados para la demostraciÃ³n. No incorporar las claves al informe, al repositorio ni a capturas pÃºblicas.\n`);
const dataset = generateSyntheticDataset({ seed: 'stockfix-2026', asOfDate: '2026-11-26', months: 36 });
const connection = await openDatabase({ databaseUrl: process.env.DATABASE_URL });
try {
  await connection.db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${STOCKFIX_WRITE_LOCK})`);
    const [loaded] = await tx.select().from(schema.demoDatasets).where(eq(schema.demoDatasets.id, 'active'));
    if (loaded) {
      if (loaded.data.id !== dataset.manifest.id) throw new Error('La base ya contiene otro dataset. No se modificÃ³.');
      return;
    }
    if ((await tx.select().from(schema.products).limit(1)).length || (await tx.select().from(schema.sales).limit(1)).length) throw new Error('La base no estÃ¡ vacÃ­a. ImportaciÃ³n cancelada.');
    await tx.insert(schema.products).values(dataset.products.map(product => ({ id: product.id, data: product })));
    await tx.insert(schema.suppliers).values(dataset.suppliers.map(supplier => ({ id: supplier.id, ruc: supplier.ruc, data: supplier })));
    await tx.insert(schema.sales).values(dataset.sales.map(operation => ({ id: operation.data.id, data: operation.data, idempotencyKey: operation.idempotencyKey, requestHash: operation.requestHash })));
    await tx.insert(schema.purchases).values(dataset.purchases.map(operation => ({ id: operation.data.id, data: operation.data, idempotencyKey: operation.idempotencyKey, requestHash: operation.requestHash })));
    for (let offset = 0; offset < dataset.stockMovements.length; offset += 500) await tx.insert(schema.stockMovements).values(dataset.stockMovements.slice(offset, offset + 500).map(movement => ({ id: movement.id, data: movement })));
    await tx.insert(schema.cashSessions).values(dataset.cashSessions.map(session => ({ id: session.id, closed: Boolean(session.closedAt), data: session })));
    await tx.insert(schema.counters).values([{ name: 'sale', value: dataset.sales.length }, { name: 'purchase', value: dataset.purchases.length }]);
    await tx.insert(schema.demoDatasets).values({ id: 'active', data: dataset.manifest, loadedAt: new Date().toISOString() });
  });
} finally { await connection.close(); }
const app = await buildApp({ databaseUrl: process.env.DATABASE_URL, seed: false, production: false, adminPassword: credentials.admin, cashierPassword: credentials.cashier, lookup: { token: '' } });
try {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@stockfix.local', password: credentials.admin } });
  if (login.statusCode !== 200) throw new Error('No se pudo verificar el acceso privado.');
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const products = await app.inject({ url: '/api/products', headers: { cookie } });
  const sales = await app.inject({ url: '/api/sales', headers: { cookie } });
  console.log(JSON.stringify({ seeded: true, database: 'Neon PostgreSQL', dataset: dataset.manifest.id, products: products.json().length, sales: sales.json().length, privateLoginVerified: true, credentialsFile: 'tmp/cloud/accesos-stockfix.txt' }));
} finally { await app.close(); }
