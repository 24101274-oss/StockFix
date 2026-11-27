import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { PresentationMinimum, Product, Summary } from '../../shared/types.js';
import { getLowStockAlerts, getPresentationMinimum, isLowStock, matchesInventory } from '../../shared/inventory.js';
import { buildApp } from '../app.js';
import { buildSummary } from '../reports.js';

const minima: PresentationMinimum[] = [{ presentationId: 'paquete', minimum: 30 }, { presentationId: 'fardo', minimum: 2 }, { presentationId: null, minimum: 0 }];
const product: Product = { id: 'minimos', sku: 'P-MIN', name: 'Bolsas con mínimos', brand: 'ALFA', category: 'Bolsas', barcode: 'COD-MIN', active: true,
  stock: { puesto: 13004, almacen: 25000 }, stockByPresentation: {
    puesto: [{ presentationId: 'paquete', quantity: 30 }, { presentationId: 'fardo', quantity: 2 }, { presentationId: null, quantity: 4 }],
    almacen: [{ presentationId: 'paquete', quantity: 0 }, { presentationId: 'fardo', quantity: 5 }, { presentationId: null, quantity: 0 }],
  }, presentations: [
    { id: 'paquete', label: 'Paquete de 100', units: 100, priceCents: 250 },
    { id: 'fardo', label: 'Fardo de 5000', units: 5000, priceCents: 11000 },
    { id: 'unidad', label: 'Unidad', units: 1, priceCents: 3 },
  ], minStockUnits: 1_000_000, minStockByPresentation: minima, sourceNotes: [] };
const edit = (original: Product, changes: Record<string, unknown> = {}) => ({ name: original.name, brand: original.brand, category: original.category, barcode: original.barcode, active: original.active, presentations: original.presentations, ...changes });
let app: FastifyInstance;
let adminCookie: string;
let cashierCookie: string;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, cookie = adminCookie) => app.inject({ method, url: `/api${url}`, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
const getProduct = async (id = 'minimos') => (await call('GET', '/products')).json<Product[]>().find(item => item.id === id)!;

before(async () => {
  app = await buildApp({ seed: [product, { ...product, id: 'editar', sku: 'P-EDIT', barcode: null, stock: { puesto: 4, almacen: 0 }, stockByPresentation: { puesto: [{ presentationId: null, quantity: 4 }], almacen: [] } }], lookup: { token: '' } });
  for (const [email, password] of [['admin@stockfix.local', 'AdminDemo2026!'], ['cajero@stockfix.local', 'CajeroDemo2026!']]) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    if (email.startsWith('admin')) adminCookie = cookie; else cashierCookie = cookie;
  }
});
after(async () => { await app.close(); });

test('presentation alerts use physical quantities and apply the same configured threshold independently to each location', () => {
  const alerts = getLowStockAlerts(product);
  assert.deepEqual(alerts, [
    { location: 'puesto', presentationId: 'paquete', presentationLabel: 'Paquete de 100', quantity: 30, minimum: 30 },
    { location: 'puesto', presentationId: 'fardo', presentationLabel: 'Fardo de 5000', quantity: 2, minimum: 2 },
    { location: 'almacen', presentationId: 'paquete', presentationLabel: 'Paquete de 100', quantity: 0, minimum: 30 },
    { location: 'almacen', presentationId: null, presentationLabel: 'Unidades sueltas', quantity: 0, minimum: 0 },
  ]);
  assert.equal(getLowStockAlerts(product, 'puesto').length, 2);
  assert.equal(getLowStockAlerts(product, 'almacen').length, 2);
  assert.equal(isLowStock(product, 'puesto'), true);
});

test('unknown, inconsistent and legacy stocks never become estimated package alerts, and inactive products have none', () => {
  for (const value of [
    { ...product, stockByPresentation: undefined },
    { ...product, stockByPresentation: { puesto: null, almacen: null } },
    { ...product, stock: { puesto: null, almacen: null } },
    { ...product, stockByPresentation: { puesto: [{ presentationId: 'paquete', quantity: 1 }], almacen: null } },
    { ...product, active: false },
    { ...product, minStockByPresentation: undefined },
    { ...product, minStockByPresentation: [] },
  ]) assert.deepEqual(getLowStockAlerts(value), []);
  const legacy = { ...product, minStockByPresentation: undefined, stock: { puesto: 0, almacen: null }, stockByPresentation: { puesto: [], almacen: null }, minStockUnits: 1_000_000 };
  assert.equal(isLowStock(legacy, 'puesto'), false);
});

test('zero means exhausted stock only and single-unit price presentations share the loose-unit threshold', () => {
  const configured: Product = { ...product, stock: { puesto: 1, almacen: 0 }, stockByPresentation: { puesto: [{ presentationId: null, quantity: 1 }], almacen: [] }, minStockByPresentation: [{ presentationId: null, minimum: 0 }] };
  assert.equal(getPresentationMinimum(configured, 'unidad'), 0);
  assert.equal(getPresentationMinimum(configured, null), 0);
  assert.equal(getPresentationMinimum(configured, 'paquete'), null);
  assert.equal(getPresentationMinimum(configured, 'faltante'), null);
  assert.deepEqual(getLowStockAlerts(configured).map(item => [item.location, item.quantity]), [['almacen', 0]]);
  assert.equal(isLowStock(configured, 'puesto'), false);
  assert.equal(isLowStock(configured, 'almacen'), true);
});

test('summary groups all presentation and location warnings into one product card and counts unique products', () => {
  const other = { ...product, id: 'otros', sku: 'P-OTRO', name: 'Otros productos' };
  const inactive = { ...product, id: 'inactivo', active: false };
  const summary = buildSummary([], [product, other, inactive], false);
  assert.equal(summary.lowStockCount, 2);
  assert.equal(summary.lowStock.length, 2);
  assert.deepEqual(summary.lowStock.find(item => item.productId === 'minimos'), { productId: product.id, name: product.name, sku: product.sku, alerts: getLowStockAlerts(product) });
  assert.ok(summary.lowStock.every(item => item.alerts.length === 4));
});

test('inventory low-stock filters use physical presentation warnings with the selected location and product search', () => {
  const onlyWarehouse: Product = { ...product, minStockByPresentation: [{ presentationId: null, minimum: 0 }] };
  assert.equal(matchesInventory(onlyWarehouse, { status: 'low', location: 'puesto' }), false);
  assert.equal(matchesInventory(onlyWarehouse, { status: 'low', location: 'almacen' }), true);
  assert.equal(matchesInventory(onlyWarehouse, { status: 'low', location: 'almacen', query: 'cod-min' }), true);
  assert.equal(matchesInventory(onlyWarehouse, { status: 'low', location: 'almacen', query: 'no coincide' }), false);
  assert.equal(matchesInventory({ ...onlyWarehouse, stockByPresentation: undefined }, { status: 'low', location: 'almacen' }), false);
});

test('known legacy totals remain pending until their physical presentation breakdown is counted', () => {
  const legacy: Product = { ...product, id: 'legacy', stockByPresentation: undefined };
  for (const location of ['puesto', 'almacen'] as const) {
    assert.equal(matchesInventory(legacy, { status: 'pending', location }), true);
    assert.equal(matchesInventory(legacy, { status: 'ready', location }), false);
    assert.equal(matchesInventory(product, { status: 'pending', location }), false);
    assert.equal(matchesInventory(product, { status: 'ready', location }), true);
  }
  const partial: Product = { ...product, stockByPresentation: { puesto: product.stockByPresentation!.puesto, almacen: null } };
  assert.equal(matchesInventory(partial, { status: 'ready', location: 'puesto' }), true);
  assert.equal(matchesInventory(partial, { status: 'pending', location: 'almacen' }), true);
  const missingPresentations: Product = { ...product, presentations: [], stock: { puesto: 0, almacen: 0 }, stockByPresentation: { puesto: [], almacen: [] } };
  assert.equal(matchesInventory(missingPresentations, { status: 'pending', location: 'puesto' }), true);
  assert.equal(matchesInventory(missingPresentations, { status: 'ready', location: 'puesto' }), false);
  const summary = buildSummary([], [product, legacy, { ...partial, id: 'partial' }, { ...legacy, id: 'inactive', active: false }], false);
  assert.equal(summary.pendingProductsCount, 2);
});

test('new presentation minima reject duplicate, stale, single-unit, fractional and malformed configurations without changes', async () => {
  const baseline = await getProduct();
  for (const minStockByPresentation of [
    [{ presentationId: 'paquete', minimum: 2 }, { presentationId: 'paquete', minimum: 3 }],
    [{ presentationId: null, minimum: 0 }, { presentationId: null, minimum: 1 }],
    [{ presentationId: 'faltante', minimum: 2 }],
    [{ presentationId: 'unidad', minimum: 2 }],
    [{ presentationId: 'paquete', minimum: -1 }],
    [{ presentationId: 'paquete', minimum: 0.5 }],
    [{ presentationId: 'paquete', minimum: 1_000_000_001 }],
    [{ presentationId: 'paquete', minimum: null }],
    [{ presentationId: 'paquete', minimum: '2' }],
    [{ presentationId: 'paquete', minimum: 2, units: 100 }],
    null,
  ]) {
    const response = await call('PATCH', '/products/minimos', edit(baseline, { minStockByPresentation }));
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(await getProduct(), baseline);
  }
  const input = edit(baseline, { minStockByPresentation: minima });
  assert.equal((await call('PATCH', '/products/minimos', input, '')).statusCode, 401);
  assert.equal((await call('PATCH', '/products/minimos', input, cashierCookie)).statusCode, 403);
});

test('product creation stores configured presentation minima while uncounted packaging produces no alerts', async () => {
  const created = await call('POST', '/products', edit(product, { name: 'Producto recién creado', barcode: null, minStockByPresentation: [{ presentationId: 'paquete', minimum: 5 }, { presentationId: null, minimum: 0 }] }));
  assert.equal(created.statusCode, 200, created.body);
  assert.deepEqual(created.json().minStockByPresentation, [{ presentationId: 'paquete', minimum: 5 }, { presentationId: null, minimum: 0 }]);
  assert.deepEqual(created.json().stock, { puesto: null, almacen: null });
  assert.deepEqual(getLowStockAlerts(created.json()), []);
});

test('omitted minima are preserved for price changes, removed empty references are pruned and explicit empty arrays disable alerts', async () => {
  const original = await getProduct('editar');
  const prices = original.presentations.map(item => ({ ...item, priceCents: item.priceCents + 1, label: `${item.label} actualizado` }));
  const priceChange = await call('PATCH', '/products/editar', edit(original, { presentations: prices }));
  assert.equal(priceChange.statusCode, 200, priceChange.body);
  assert.deepEqual(priceChange.json().minStockByPresentation, minima);
  const withoutPack = prices.filter(item => item.id !== 'paquete');
  const deleted = await call('PATCH', '/products/editar', edit(original, { presentations: withoutPack }));
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.deepEqual(deleted.json().minStockByPresentation, [{ presentationId: 'fardo', minimum: 2 }, { presentationId: null, minimum: 0 }]);
  const wrongReference = await call('PATCH', '/products/editar', edit(original, { presentations: withoutPack, minStockByPresentation: minima }));
  assert.equal(wrongReference.statusCode, 400, wrongReference.body);
  const asUnit = withoutPack.map(item => item.id === 'fardo' ? { ...item, units: 1 } : item);
  const changed = await call('PATCH', '/products/editar', edit(original, { presentations: asUnit }));
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(changed.json().minStockByPresentation, [{ presentationId: null, minimum: 0 }]);
  const cleared = await call('PATCH', '/products/editar', edit(original, { presentations: asUnit, minStockByPresentation: [] }));
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.deepEqual(cleared.json().minStockByPresentation, []);
  assert.deepEqual(getLowStockAlerts(cleared.json()), []);
});

test('summary API returns grouped physical quantities and ignores legacy totals after a legacy recount', async () => {
  const summary = (await call('GET', '/summary')).json<Summary>();
  const current = summary.lowStock.find(item => item.productId === 'minimos');
  assert.ok(current);
  assert.equal(current.alerts.length, 4);
  const counted = await call('POST', '/stock/adjust', { productId: 'minimos', location: 'puesto', quantityUnits: 13004 });
  assert.equal(counted.statusCode, 200, counted.body);
  const changed = (await call('GET', '/summary')).json<Summary>().lowStock.find(item => item.productId === 'minimos');
  assert.ok(changed);
  assert.deepEqual(changed.alerts.map(item => item.location), ['almacen', 'almacen']);
});
