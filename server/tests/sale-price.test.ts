import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import type { Product, Sale } from '../../shared/types.js';
import { buildApp } from '../app.js';
import { closeCashSchema, MAX_CENTS, openCashSchema, productSchema, purchaseSchema } from '../validation.js';

const input = (priceCents: number) => ({
  name: 'Producto de regresión DDS-9', brand: '', category: 'Prueba', barcode: null, active: true,
  presentations: [{ id: 'unidad', label: 'Unidad', units: 1, priceCents }],
});
const seed = (id: string, priceCents: number): Product => ({
  ...input(priceCents), id, sku: `DDS9-${id}`, sourceNotes: [],
  stock: { puesto: 2, almacen: 0 },
  stockByPresentation: { puesto: [{ presentationId: null, quantity: 2 }], almacen: [] },
});
let app: FastifyInstance;
let cookie: string;
let directory: string;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({
  method, url: `/api${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }),
});
const snapshot = async () => ({
  products: (await call('GET', '/products')).json(), sales: (await call('GET', '/sales')).json(),
  cash: (await call('GET', '/cash')).json(), movements: (await call('GET', '/stock/movements')).json(),
});
const sale = (productIds: string[], paidCents = 0) => ({
  idempotencyKey: randomUUID(), documentType: 'ticket', customerId: null, paymentMethod: 'efectivo', paidCents,
  items: productIds.map(productId => ({ productId, presentationId: 'unidad', quantity: 1, location: 'puesto' })),
});

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stockfix-dds9-'));
  const initial = await buildApp({ dataDir: directory, seed: [seed('valido', 1), seed('legado', 1)], lookup: { token: '' } });
  await initial.close();
  // Simulate an already persisted zero-price record, bypassing the now stricter
  // import validator. This is a temporary test database, never the demo database.
  const database = new PGlite(directory);
  try {
    await database.query("UPDATE products SET data = jsonb_set(data, '{presentations,0,priceCents}', '0'::jsonb) WHERE id = $1", ['legado']);
  } finally { await database.close(); }
  app = await buildApp({ dataDir: directory, seed: false, lookup: { token: '' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@stockfix.local', password: 'AdminDemo2026!' } });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  assert.equal((await call('POST', '/cash/open', { openingCents: 0 })).statusCode, 200);
});
after(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('DDS-9: sale prices reject zero, negatives, fractions and out-of-range amounts', () => {
  for (const amount of [0, -1, 0.5, MAX_CENTS + 1]) assert.equal(productSchema.safeParse(input(amount)).success, false, String(amount));
});

test('DDS-9: one cent and the existing maximum remain valid sale prices', () => {
  for (const amount of [1, MAX_CENTS]) assert.equal(productSchema.safeParse(input(amount)).success, true);
});

test('DDS-9: valid zero cash balances and purchase costs are preserved', () => {
  assert.equal(openCashSchema.safeParse({ openingCents: 0 }).success, true);
  assert.equal(closeCashSchema.safeParse({ countedCents: 0 }).success, true);
  assert.equal(purchaseSchema.safeParse({ idempotencyKey: randomUUID(), supplierId: 'demo', document: '',
    location: 'almacen', paymentMethod: 'efectivo', paidFromCash: false, totalPaidCents: 0,
    items: [{ productId: 'demo', presentationId: 'unidad', quantity: 1, unitCostCents: 0 }],
  }).success, true);
});

test('DDS-9: POST rejects a zero price without creating a product', async () => {
  const before = await snapshot();
  const response = await call('POST', '/products', input(0));
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(await snapshot(), before);
});

test('DDS-9: PATCH rejects a zero price without changing the product or business state', async () => {
  const before = await snapshot();
  const response = await call('PATCH', '/products/valido', input(0));
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(await snapshot(), before);
});

test('DDS-9: a legacy zero-price sale is blocked without changing stock, sales, cash or movements', async () => {
  const before = await snapshot();
  const response = await call('POST', '/sales', sale(['legado']));
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().message, /precio.*mayor que cero/i);
  assert.deepEqual(await snapshot(), before);
});

test('DDS-9: a mixed basket with a legacy zero price rolls back every line', async () => {
  const before = await snapshot();
  const response = await call('POST', '/sales', sale(['valido', 'legado'], 1));
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(await snapshot(), before);
});

test('DDS-9: correcting the legacy price permits a normal idempotent sale', async () => {
  assert.equal((await call('PATCH', '/products/legado', input(1))).statusCode, 200);
  const request = sale(['legado'], 1);
  const first = await call('POST', '/sales', request);
  assert.equal(first.statusCode, 200, first.body);
  const result = first.json<Sale>();
  assert.equal(result.totalCents, 1);
  assert.equal(result.items[0].unitPriceCents, 1);
  assert.equal(result.changeCents, 0);
  assert.equal((await call('POST', '/sales', request)).json<Sale>().id, result.id);
  const products = (await call('GET', '/products')).json<Product[]>();
  assert.equal(products.find(product => product.id === 'legado')?.stock.puesto, 1);
  assert.equal((await call('GET', '/sales')).json<Sale[]>().length, 1);
});
