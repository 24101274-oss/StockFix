import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { openDatabase } from '../server/database.js';
import { buildApp } from '../server/app.js';

process.loadEnvFile('.env.local');
const originalURL = process.env.DATABASE_URL!;
const schemaName = `qa_cloud_${randomBytes(6).toString('hex')}`;
assert.match(schemaName, /^qa_cloud_[a-f0-9]{12}$/);
const root = await openDatabase({ databaseUrl: originalURL });
let created = false;
let first: Awaited<ReturnType<typeof buildApp>> | undefined;
let second: Awaited<ReturnType<typeof buildApp>> | undefined;
const previousOrigin = process.env.APP_ORIGIN;
process.env.APP_ORIGIN = 'https://stockfix-24101274.vercel.app';
try {
  await root.db.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`)); created = true;
  const isolated = new URL(process.env.DATABASE_URL_UNPOOLED ?? originalURL);
  isolated.searchParams.set('options', `-c search_path=${schemaName}`);
  const options = { databaseUrl: isolated.toString(), seed: false as const, production: true,
    adminPassword: randomBytes(20).toString('base64url'), cashierPassword: randomBytes(20).toString('base64url'),
    lookup: { token: '' }, allowedOrigins: [process.env.APP_ORIGIN] };
  first = await buildApp(options);
  const login = await first.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@stockfix.local', password: options.adminPassword } });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  second = await buildApp(options);
  assert.equal((await second.inject({ url: '/api/auth/me', headers })).statusCode, 200, 'New instance must retain earlier sessions.');
  const productResponse = await first.inject({ method: 'POST', url: '/api/products', headers, payload: {
    name: 'QA temporal nube', brand: 'DEMO', category: 'Prueba aislada', barcode: null, active: true,
    presentations: [{ id: 'qa-unit', label: 'Unidad', units: 1, priceCents: 100 }],
  } });
  assert.equal(productResponse.statusCode, 200, productResponse.body);
  const product = productResponse.json();
  const stock = await first.inject({ method: 'POST', url: '/api/stock/adjust', headers, payload: { productId: product.id, location: 'puesto', counts: [{ presentationId: null, quantity: 1 }], reason: 'Prueba aislada en esquema temporal' } });
  assert.equal(stock.statusCode, 200, stock.body);
  const cash = await first.inject({ method: 'POST', url: '/api/cash/open', headers, payload: { openingCents: 0 } });
  assert.equal(cash.statusCode, 200, cash.body);
  const payload = (idempotencyKey: string) => ({ idempotencyKey, documentType: 'ticket', customerId: null, paymentMethod: 'efectivo', paidCents: 100,
    items: [{ productId: product.id, presentationId: 'qa-unit', quantity: 1, location: 'puesto' }] });
  const results = await Promise.all([first.inject({ method: 'POST', url: '/api/sales', headers, payload: payload('qa-cloud-sale-0000001') }), second.inject({ method: 'POST', url: '/api/sales', headers, payload: payload('qa-cloud-sale-0000002') })]);
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
  const saved = (await second.inject({ url: '/api/products', headers })).json().find((item: any) => item.id === product.id);
  assert.equal(saved.stock.puesto, 0);
  assert.equal((await second.inject({ url: '/api/sales', headers })).json().length, 1);
  await first.close(); first = undefined;
  assert.equal((await second.inject({ url: '/api/auth/me', headers })).statusCode, 200);
  const result = { verifiedAt: new Date().toISOString(), database: 'Neon PostgreSQL', isolatedSchema: true,
    sessionsAcrossInstances: true, concurrentSaleStatuses: results.map(result => result.statusCode).sort(), finalStock: 0, sales: 1, productionDatasetUntouched: true };
  await writeFile('tmp/cloud/remote-verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (first) await first.close(); if (second) await second.close();
  if (created) await root.db.execute(sql.raw(`DROP SCHEMA "${schemaName}" CASCADE`));
  await root.close();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin;
}
