import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Presentation, Product, StockMovement } from '../../shared/types';
import { countStockUnits, getPackagingStock } from '../../shared/stock-packaging';
import { buildApp } from '../app';

const presentations: Presentation[] = [
  { id: 'fardo', label: 'Fardo de 50 paquetes', units: 5000, priceCents: 11000 },
  { id: 'paquete', label: 'Paquete de 100', units: 100, priceCents: 250 },
  { id: 'millar', label: 'Millar', units: 1000, priceCents: 2400 },
  { id: 'sesenta', label: 'Paquete de 60', units: 60, priceCents: 200 },
  { id: 'unidad', label: 'Unidad', units: 1, priceCents: 3 },
];
const product = (id: string): Product => ({ id, sku: id, name: `Bolsas ${id}`, brand: '', category: 'Bolsas', barcode: null, active: true,
  stock: { puesto: null, almacen: null }, presentations, sourceNotes: [] });
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
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, cookie = adminCookie) => app.inject({
  method, url: `/api${url}`, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }),
});
const unpack = (productId: string, changes: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(), productId, location: 'puesto', fromPresentationId: 'fardo', toPresentationId: 'paquete', quantity: 1, reason: 'Abrir empaque para venta', ...changes,
});
const getProduct = async (id: string) => (await call('GET', '/products')).json<Product[]>().find(item => item.id === id)!;
const state = async (id: string) => ({ product: await getProduct(id), movements: (await call('GET', '/stock/movements')).json<StockMovement[]>() });
const quantity = (product: Product, location: 'puesto' | 'almacen', presentationId: string | null) => product.stockByPresentation?.[location]?.find(item => item.presentationId === presentationId)?.quantity;
const count = async (id: string, rows: { presentationId: string | null; quantity: number }[], location = 'puesto') => {
  const response = await call('POST', '/stock/adjust', { productId: id, location, counts: rows, reason: 'Conteo físico de empaques' });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Product>();
};
const editable = (product: Product, presentations = product.presentations) => ({ name: product.name, brand: product.brand, category: product.category, barcode: product.barcode, active: product.active, presentations });

before(async () => {
  app = await buildApp({ seed: ['exacto', 'unidades', 'invalido', 'legacy', 'reintentos', 'edicion', 'vaciopuesto'].map(product), lookup: { token: '' } });
  adminCookie = await login(app);
  cashierCookie = await login(app, true);
});
after(async () => { await app.close(); });

test('opening one fardo creates fifty physical packages, preserves total stock and records one zero-delta movement', async () => {
  await count('exacto', [{ presentationId: 'fardo', quantity: 2 }, { presentationId: 'paquete', quantity: 3 }, { presentationId: null, quantity: 7 }]);
  await count('exacto', [{ presentationId: 'fardo', quantity: 1 }], 'almacen');
  const before = await getProduct('exacto');
  const response = await call('POST', '/stock/unpack', unpack('exacto'));
  assert.equal(response.statusCode, 200, response.body);
  const after = response.json<Product>();
  assert.deepEqual(after.stock, before.stock);
  assert.equal(quantity(after, 'puesto', 'fardo'), 1);
  assert.equal(quantity(after, 'puesto', 'paquete'), 53);
  assert.equal(quantity(after, 'puesto', null), 7);
  assert.deepEqual(after.stockByPresentation?.almacen, before.stockByPresentation?.almacen);
  const breakdown = getPackagingStock(after, 'puesto');
  assert.ok(breakdown);
  assert.equal(countStockUnits(after.presentations, breakdown), before.stock.puesto);
  const movements = (await state('exacto')).movements.filter(item => item.productId === 'exacto' && item.type === 'apertura_empaque');
  assert.equal(movements.length, 1);
  assert.equal(movements[0].quantityUnits, 0);
  assert.match(movements[0].reason, /1 × Fardo de 50 paquetes → 50 × Paquete de 100/);
});

test('opening into null or a configured single-unit presentation uses the same loose-unit balance', async () => {
  await count('unidades', [{ presentationId: 'paquete', quantity: 3 }, { presentationId: null, quantity: 5 }]);
  for (const toPresentationId of [null, 'unidad']) {
    const response = await call('POST', '/stock/unpack', unpack('unidades', { fromPresentationId: 'paquete', toPresentationId }));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().stock.puesto, 305);
  }
  const result = await getProduct('unidades');
  assert.equal(quantity(result, 'puesto', 'paquete'), 1);
  assert.equal(quantity(result, 'puesto', null), 205);
  assert.equal(result.stockByPresentation?.puesto?.some(item => item.presentationId === 'unidad'), false);
});

test('invalid directions, inexact ratios, missing presentations and insufficient closed packs roll back completely', async () => {
  await count('invalido', [{ presentationId: 'fardo', quantity: 1 }, { presentationId: 'paquete', quantity: 1 }]);
  const baseline = await state('invalido');
  for (const [changes, expected] of [
    [{ fromPresentationId: 'paquete', toPresentationId: 'fardo' }, 400],
    [{ fromPresentationId: 'paquete', toPresentationId: 'paquete' }, 400],
    [{ fromPresentationId: 'paquete', toPresentationId: 'sesenta' }, 400],
    [{ fromPresentationId: 'unidad', toPresentationId: null }, 400],
    [{ fromPresentationId: 'faltante' }, 409],
    [{ toPresentationId: 'faltante' }, 409],
    [{ quantity: 2 }, 409],
    [{ quantity: 0 }, 400],
    [{ quantity: 0.5 }, 400],
    [{ quantity: '1' }, 400],
    [{ quantity: 1_000_001 }, 400],
    [{ location: 'local-desconocido' }, 400],
    [{ units: 1 }, 400],
    [{ idempotencyKey: 'corto' }, 400],
  ] as const) {
    const response = await call('POST', '/stock/unpack', unpack('invalido', changes));
    assert.equal(response.statusCode, expected, response.body);
    assert.deepEqual(await state('invalido'), baseline);
  }
  const retryable = unpack('invalido', { quantity: 2 });
  assert.equal((await call('POST', '/stock/unpack', retryable)).statusCode, 409);
  await count('invalido', [{ presentationId: 'fardo', quantity: 2 }]);
  const validRetry = await call('POST', '/stock/unpack', retryable);
  assert.equal(validRetry.statusCode, 200, validRetry.body);
  assert.equal(quantity(validRetry.json(), 'puesto', 'paquete'), 100);
});

test('an unconfirmed packaging breakdown cannot be opened and the operation requires an administrator', async () => {
  const prepared = await call('POST', '/stock/adjust', { productId: 'legacy', location: 'puesto', quantityUnits: 5000, reason: 'Conteo antiguo sólo de unidades' });
  assert.equal(prepared.statusCode, 200, prepared.body);
  const baseline = await state('legacy');
  assert.equal((await call('POST', '/stock/unpack', unpack('legacy'))).statusCode, 409);
  assert.equal((await call('POST', '/stock/unpack', unpack('legacy'), '')).statusCode, 401);
  assert.equal((await call('POST', '/stock/unpack', unpack('legacy'), cashierCookie)).statusCode, 403);
  assert.deepEqual(await state('legacy'), baseline);
  const unknownLocation = await call('POST', '/stock/unpack', unpack('legacy', { location: 'almacen' }));
  assert.equal(unknownLocation.statusCode, 409, unknownLocation.body);
});

test('sequential and concurrent retries open stock only once and a changed payload with the same key conflicts', async () => {
  await count('reintentos', [{ presentationId: 'fardo', quantity: 2 }]);
  const input = unpack('reintentos');
  const responses = await Promise.all([call('POST', '/stock/unpack', input), call('POST', '/stock/unpack', input)]);
  assert.deepEqual(responses.map(response => response.statusCode), [200, 200]);
  for (const response of responses) {
    assert.equal(quantity(response.json(), 'puesto', 'fardo'), 1);
    assert.equal(quantity(response.json(), 'puesto', 'paquete'), 50);
    assert.equal(response.json().stock.puesto, 10000);
  }
  const baseline = await state('reintentos');
  assert.equal((await call('POST', '/stock/unpack', input)).statusCode, 200);
  assert.deepEqual(await state('reintentos'), baseline);
  const conflict = await call('POST', '/stock/unpack', { ...input, quantity: 2 });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.deepEqual(await state('reintentos'), baseline);
  assert.equal(baseline.movements.filter(item => item.productId === 'reintentos' && item.type === 'apertura_empaque').length, 1);
});

test('product editing protects the meaning of occupied packs while allowing prices, labels and empty presentation changes', async () => {
  await count('edicion', [{ presentationId: 'fardo', quantity: 1 }, { presentationId: 'paquete', quantity: 2 }]);
  await count('edicion', [{ presentationId: 'millar', quantity: 3 }], 'almacen');
  const original = await getProduct('edicion');
  for (const next of [
    original.presentations.filter(item => item.id !== 'fardo'),
    original.presentations.map(item => item.id === 'paquete' ? { ...item, units: 200 } : item),
    original.presentations.filter(item => item.id !== 'millar'),
    original.presentations.map(item => item.id === 'millar' ? { ...item, units: 500 } : item),
  ]) {
    const response = await call('PATCH', '/products/edicion', editable(original, next));
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(await getProduct('edicion'), original);
  }
  const renamed = original.presentations.map(item => item.id === 'fardo' ? { ...item, label: 'Fardo cerrado de 5000', priceCents: 12500 } : item);
  const allowed = await call('PATCH', '/products/edicion', editable(original, renamed));
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.deepEqual(allowed.json().stock, original.stock);
  assert.deepEqual(allowed.json().stockByPresentation, original.stockByPresentation);
  const changed = renamed.filter(item => item.id !== 'sesenta').concat({ id: 'caja', label: 'Caja de 200', units: 200, priceCents: 500 });
  const added = await call('PATCH', '/products/edicion', editable(original, changed));
  assert.equal(added.statusCode, 200, added.body);
  const result = added.json<Product>();
  for (const location of ['puesto', 'almacen'] as const) {
    assert.equal(quantity(result, location, 'caja'), 0);
    assert.equal(result.stockByPresentation?.[location]?.some(item => item.presentationId === 'sesenta'), false);
    const confirmed = getPackagingStock(result, location);
    assert.ok(confirmed);
    assert.equal(countStockUnits(result.presentations, confirmed), original.stock[location]);
  }
});

test('presentation editing checks warehouse packaging even when the market stall is empty', async () => {
  await count('vaciopuesto', [{ presentationId: null, quantity: 0 }]);
  await count('vaciopuesto', [{ presentationId: 'fardo', quantity: 1 }], 'almacen');
  const before = await getProduct('vaciopuesto');
  const response = await call('PATCH', '/products/vaciopuesto', editable(before, before.presentations.filter(item => item.id !== 'fardo')));
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(await getProduct('vaciopuesto'), before);
});

test('physical package counts, an opening and its idempotency record survive a database restart', async () => {
  const temporaryRoot = resolve('tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'stockfix-packaging-persistence-'));
  let persistent: FastifyInstance | undefined;
  try {
    persistent = await buildApp({ dataDir: directory, seed: [product('persistente')], lookup: { token: '' } });
    let cookie = await login(persistent);
    const counted = await persistent.inject({ method: 'POST', url: '/api/stock/adjust', headers: { cookie }, payload: { productId: 'persistente', location: 'puesto', counts: [{ presentationId: 'fardo', quantity: 2 }, { presentationId: null, quantity: 9 }], reason: 'Conteo persistente de empaques' } });
    assert.equal(counted.statusCode, 200, counted.body);
    const input = unpack('persistente');
    const opened = await persistent.inject({ method: 'POST', url: '/api/stock/unpack', headers: { cookie }, payload: input });
    assert.equal(opened.statusCode, 200, opened.body);
    const expected = opened.json<Product>();
    const movements = await persistent.inject({ method: 'GET', url: '/api/stock/movements', headers: { cookie } });
    const expectedHistory = movements.json<StockMovement[]>();
    await persistent.close();
    persistent = undefined;
    persistent = await buildApp({ dataDir: directory, seed: false, lookup: { token: '' } });
    cookie = await login(persistent);
    const restored = await persistent.inject({ method: 'GET', url: '/api/products', headers: { cookie } });
    assert.deepEqual(restored.json<Product[]>()[0], expected);
    assert.equal(quantity(restored.json<Product[]>()[0], 'puesto', 'fardo'), 1);
    assert.equal(quantity(restored.json<Product[]>()[0], 'puesto', 'paquete'), 50);
    assert.equal(quantity(restored.json<Product[]>()[0], 'puesto', null), 9);
    const retry = await persistent.inject({ method: 'POST', url: '/api/stock/unpack', headers: { cookie }, payload: input });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json<Product>(), expected);
    const restoredHistory = await persistent.inject({ method: 'GET', url: '/api/stock/movements', headers: { cookie } });
    assert.deepEqual(restoredHistory.json<StockMovement[]>(), expectedHistory);
  } finally {
    await persistent?.close();
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(`${temporaryRoot}${sep}stockfix-packaging-persistence-`));
    await rm(absolute, { recursive: true, force: true });
  }
});
