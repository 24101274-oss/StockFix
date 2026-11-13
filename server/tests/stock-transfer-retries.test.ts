import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Product, StockMovement } from '../../shared/types';
import { buildApp } from '../app';

const product = (id: string): Product => ({ id, sku: id, name: `Traslado ${id}`, brand: '', category: 'Bolsas', barcode: null, active: true,
  stock: { puesto: null, almacen: null }, presentations: [
    { id: 'paquete', label: 'Paquete de 100', units: 100, priceCents: 250 },
    { id: 'fardo', label: 'Fardo de 5000', units: 5000, priceCents: 10000 },
  ], sourceNotes: [] });
let app: FastifyInstance;
let adminCookie: string;
let cashierCookie: string;
const login = async (instance: FastifyInstance, cashier = false) => {
  const response = await instance.inject({ method: 'POST', url: '/api/auth/login', payload: {
    email: cashier ? 'cajero@stockfix.local' : 'admin@stockfix.local', password: cashier ? 'CajeroDemo2026!' : 'AdminDemo2026!',
  } });
  assert.equal(response.statusCode, 200, response.body);
  return String(response.headers['set-cookie']).split(';')[0];
};
const call = (method: 'GET' | 'POST', url: string, payload?: unknown, cookie = adminCookie) => app.inject({
  method, url: `/api${url}`, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }),
});
const transfer = (productId: string, changes: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(), productId, from: 'puesto', to: 'almacen', counts: [{ presentationId: 'fardo', quantity: 1 }], reason: 'Reponer mercadería de prueba', ...changes,
});
const getProduct = async (id: string) => (await call('GET', '/products')).json<Product[]>().find(item => item.id === id)!;
const state = async () => ({ products: (await call('GET', '/products')).json<Product[]>(), movements: (await call('GET', '/stock/movements')).json<StockMovement[]>() });
const physical = (product: Product, location: 'puesto' | 'almacen', presentationId: string | null) => product.stockByPresentation?.[location]?.find(item => item.presentationId === presentationId)?.quantity;
const prepare = async (id: string, fardos: number) => {
  for (const [location, counts] of [['puesto', [{ presentationId: 'fardo', quantity: fardos }]], ['almacen', [{ presentationId: null, quantity: 0 }]]] as const) {
    const response = await call('POST', '/stock/adjust', { productId: id, location, counts, reason: 'Conteo comprobado de pruebas' });
    assert.equal(response.statusCode, 200, response.body);
  }
};

before(async () => {
  app = await buildApp({ seed: ['secuencial', 'concurrente', 'conflicto', 'otro', 'fallido', 'legacy'].map(product), lookup: { token: '' } });
  adminCookie = await login(app);
  cashierCookie = await login(app, true);
});
after(async () => { await app.close(); });

test('retrying a saved physical transfer does not move stock or duplicate either movement', async () => {
  await prepare('secuencial', 10);
  const input = transfer('secuencial', { counts: [{ presentationId: 'fardo', quantity: 2 }] });
  const first = await call('POST', '/stock/transfer', input);
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().stock, { puesto: 40000, almacen: 10000 });
  assert.equal(physical(first.json(), 'puesto', 'fardo'), 8);
  assert.equal(physical(first.json(), 'almacen', 'fardo'), 2);
  const baseline = await state();
  for (let attempt = 0; attempt < 3; attempt++) {
    const repeated = await call('POST', '/stock/transfer', input);
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.deepEqual(repeated.json(), first.json());
    assert.deepEqual(await state(), baseline);
  }
  const movements = baseline.movements.filter(item => item.productId === 'secuencial' && item.type.startsWith('traslado_'));
  assert.equal(movements.length, 2);
  assert.deepEqual(movements.map(item => item.quantityUnits).sort((a, b) => a - b), [-10000, 10000]);
});

test('concurrent deliveries of the same request key commit exactly one transfer', async () => {
  await prepare('concurrente', 2);
  const input = transfer('concurrente');
  const responses = await Promise.all(Array.from({ length: 4 }, () => call('POST', '/stock/transfer', input)));
  assert.deepEqual(responses.map(response => response.statusCode), [200, 200, 200, 200]);
  for (const response of responses) {
    assert.deepEqual(response.json().stock, { puesto: 5000, almacen: 5000 });
    assert.equal(physical(response.json(), 'puesto', 'fardo'), 1);
    assert.equal(physical(response.json(), 'almacen', 'fardo'), 1);
  }
  assert.equal((await state()).movements.filter(item => item.productId === 'concurrente' && item.type.startsWith('traslado_')).length, 2);
});

test('reusing a transfer key with another quantity, direction, reason or product conflicts without side effects', async () => {
  await prepare('conflicto', 3);
  await prepare('otro', 2);
  const input = transfer('conflicto');
  const first = await call('POST', '/stock/transfer', input);
  assert.equal(first.statusCode, 200, first.body);
  const baseline = await state();
  for (const changes of [
    { counts: [{ presentationId: 'fardo', quantity: 2 }] },
    { from: 'almacen', to: 'puesto' },
    { reason: 'Otro traslado' },
    { productId: 'otro' },
  ]) {
    const conflict = await call('POST', '/stock/transfer', { ...input, ...changes });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.deepEqual(await state(), baseline);
  }
  // Idempotency only controls duplication; it never bypasses authentication.
  assert.equal((await call('POST', '/stock/transfer', input, '')).statusCode, 401);
  assert.equal((await call('POST', '/stock/transfer', input, cashierCookie)).statusCode, 403);
  assert.deepEqual(await state(), baseline);
});

test('a rolled-back transfer does not reserve its key, so it may succeed once after correcting the stock', async () => {
  await prepare('fallido', 0);
  const input = transfer('fallido');
  const baseline = await state();
  const insufficient = await call('POST', '/stock/transfer', input);
  assert.equal(insufficient.statusCode, 409, insufficient.body);
  assert.deepEqual(await state(), baseline);
  await prepare('fallido', 2);
  const corrected = await call('POST', '/stock/transfer', input);
  assert.equal(corrected.statusCode, 200, corrected.body);
  assert.deepEqual(corrected.json().stock, { puesto: 5000, almacen: 5000 });
  const correctedState = await state();
  assert.equal((await call('POST', '/stock/transfer', input)).statusCode, 200);
  assert.deepEqual(await state(), correctedState);
});

test('legacy base-unit transfers may supply a request key and old callers without one remain supported', async () => {
  await prepare('legacy', 1);
  const input = { productId: 'legacy', from: 'puesto', to: 'almacen', quantityUnits: 100, reason: 'Traslado de unidades', idempotencyKey: randomUUID() };
  const first = await call('POST', '/stock/transfer', input);
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().stock, { puesto: 4900, almacen: 100 });
  assert.deepEqual(first.json().stockByPresentation, { puesto: null, almacen: null });
  const baseline = await state();
  assert.equal((await call('POST', '/stock/transfer', input)).statusCode, 200);
  assert.deepEqual(await state(), baseline);
  const { idempotencyKey: _key, ...withoutKey } = input;
  const oldCaller = await call('POST', '/stock/transfer', withoutKey);
  assert.equal(oldCaller.statusCode, 200, oldCaller.body);
  assert.deepEqual(oldCaller.json().stock, { puesto: 4800, almacen: 200 });
  const current = await state();
  for (const idempotencyKey of ['', 'short', null, 12, 'x'.repeat(129)]) {
    const invalid = await call('POST', '/stock/transfer', { ...input, idempotencyKey });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.deepEqual(await state(), current);
  }
  assert.equal((await getProduct('legacy')).stock.puesto, 4800);
});

test('saved transfer attempts and packaging persist across restart and remain safe to retry', async () => {
  const temporaryRoot = resolve('tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'stockfix-transfer-persistence-'));
  let persistent: FastifyInstance | undefined;
  try {
    persistent = await buildApp({ dataDir: directory, seed: [product('persistente')], lookup: { token: '' } });
    let cookie = await login(persistent);
    for (const [location, counts] of [['puesto', [{ presentationId: 'fardo', quantity: 3 }]], ['almacen', [{ presentationId: null, quantity: 0 }]]] as const) {
      const adjusted: LightMyRequestResponse = await persistent.inject({ method: 'POST', url: '/api/stock/adjust', headers: { cookie }, payload: { productId: 'persistente', location, counts, reason: 'Conteo de prueba persistente' } });
      assert.equal(adjusted.statusCode, 200, adjusted.body);
    }
    const input = transfer('persistente', { counts: [{ presentationId: 'fardo', quantity: 2 }] });
    const moved = await persistent.inject({ method: 'POST', url: '/api/stock/transfer', headers: { cookie }, payload: input });
    assert.equal(moved.statusCode, 200, moved.body);
    const expected = moved.json<Product>();
    const history = (await persistent.inject({ method: 'GET', url: '/api/stock/movements', headers: { cookie } })).json<StockMovement[]>();
    await persistent.close();
    persistent = undefined;
    persistent = await buildApp({ dataDir: directory, seed: false, lookup: { token: '' } });
    cookie = await login(persistent);
    const retry = await persistent.inject({ method: 'POST', url: '/api/stock/transfer', headers: { cookie }, payload: input });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json<Product>(), expected);
    assert.equal(physical(retry.json(), 'puesto', 'fardo'), 1);
    assert.equal(physical(retry.json(), 'almacen', 'fardo'), 2);
    assert.deepEqual((await persistent.inject({ method: 'GET', url: '/api/stock/movements', headers: { cookie } })).json<StockMovement[]>(), history);
    const changed = await persistent.inject({ method: 'POST', url: '/api/stock/transfer', headers: { cookie }, payload: { ...input, counts: [{ presentationId: 'fardo', quantity: 1 }] } });
    assert.equal(changed.statusCode, 409, changed.body);
    assert.deepEqual((await persistent.inject({ method: 'GET', url: '/api/products', headers: { cookie } })).json<Product[]>()[0], expected);
  } finally {
    await persistent?.close();
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(`${temporaryRoot}${sep}stockfix-transfer-persistence-`));
    await rm(absolute, { recursive: true, force: true });
  }
});
