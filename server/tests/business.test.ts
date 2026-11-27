import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Product, Sale } from '../../shared/types.js';
import { buildApp } from '../app.js';

const seed: Product[] = [
  { id: 'bolsas', sku: 'P-001', name: 'Bolsas de prueba', brand: 'ALFA', category: 'Bolsas', barcode: null, active: true, stock: { puesto: null, almacen: null }, presentations: [{ id: 'paq', label: 'Paquete de 100', units: 100, priceCents: 250 }], sourceNotes: [] },
  { id: 'vasos', sku: 'P-002', name: 'Vasos de prueba', brand: '', category: 'Vasos', barcode: null, active: true, stock: { puesto: null, almacen: null }, presentations: [{ id: 'unidad', label: 'Unidad', units: 1, priceCents: 100 }], sourceNotes: [] },
];
let app: FastifyInstance;
let adminCookie: string;
let cashierCookie: string;
let supplierId: string;
const cashIngreso = { idempotencyKey: randomUUID(), type: 'ingreso', amountCents: 100, reason: 'Ingreso con reintento' };
const cashEgreso = { idempotencyKey: randomUUID(), type: 'egreso', amountCents: 100, reason: 'Egreso con reintento' };
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, cookie = adminCookie) => app.inject({ method, url: `/api${url}`, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
const saleInput = (changes: Record<string, unknown> = {}) => ({ idempotencyKey: randomUUID(), documentType: 'boleta', customerId: null, paymentMethod: 'efectivo', paidCents: 1000, items: [{ productId: 'bolsas', presentationId: 'paq', quantity: 2, location: 'puesto' }], ...changes });

before(async () => {
  app = await buildApp({ seed, lookup: { token: '' } });
  const admin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@stockfix.local', password: 'AdminDemo2026!' } });
  assert.equal(admin.statusCode, 200);
  adminCookie = String(admin.headers['set-cookie']).split(';')[0];
  const cashier = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'cajero@stockfix.local', password: 'CajeroDemo2026!' } });
  cashierCookie = String(cashier.headers['set-cookie']).split(';')[0];
});
after(async () => { await app.close(); });

test('authentication, cookie security, server roles and origin rejection', async () => {
  assert.equal((await call('GET', '/products', undefined, '')).statusCode, 401);
  assert.equal((await call('GET', '/summary', undefined, cashierCookie)).statusCode, 403);
  assert.equal((await call('GET', '/purchases', undefined, cashierCookie)).statusCode, 403);
  assert.equal((await call('POST', '/stock/adjust', { productId: 'bolsas', location: 'puesto', quantityUnits: 10, reason: 'Conteo' }, cashierCookie)).statusCode, 403);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@stockfix.local', password: 'AdminDemo2026!' } });
  assert.match(String(login.headers['set-cookie']), /HttpOnly/);
  assert.match(String(login.headers['set-cookie']), /SameSite=Strict/i);
  assert.equal(Object.hasOwn(login.json(), 'passwordHash'), false);
  const forged = await app.inject({ method: 'POST', url: '/api/cash/open', headers: { cookie: adminCookie, origin: 'https://otro-sitio.example' }, payload: { openingCents: 10000 } });
  assert.equal(forged.statusCode, 403);
});

test('stock remains pending until counted, sales require an open register', async () => {
  assert.equal((await call('GET', '/products')).json()[0].stock.puesto, null);
  assert.equal((await call('POST', '/sales', saleInput())).statusCode, 409);
  assert.equal((await call('POST', '/cash/open', { openingCents: 10000 })).statusCode, 200);
  assert.equal((await call('POST', '/cash/open', { openingCents: 10000 })).statusCode, 409);
  assert.equal((await call('POST', '/sales', saleInput())).statusCode, 409);
  for (const [productId, quantityUnits] of [['bolsas', 1000], ['vasos', 10]] as const) {
    assert.equal((await call('POST', '/stock/adjust', { productId, location: 'puesto', quantityUnits, reason: 'Conteo inicial verificado' })).statusCode, 200);
    assert.equal((await call('POST', '/stock/adjust', { productId, location: 'almacen', quantityUnits: 0, reason: 'Conteo almacén vacío' })).statusCode, 200);
  }
});

test('a sale deducts base units, trusts server prices and retry is idempotent', async () => {
  const input = saleInput();
  const response = await call('POST', '/sales', input, cashierCookie);
  assert.equal(response.statusCode, 200, response.body);
  const sale = response.json<Sale>();
  assert.equal(sale.number, 'PR-000001');
  assert.equal(sale.status, 'PRUEBA');
  assert.equal(sale.totalCents, 500);
  assert.equal(sale.changeCents, 500);
  assert.equal(sale.items[0].units, 200);
  const retried = await call('POST', '/sales', input, cashierCookie);
  assert.equal(retried.json().id, sale.id);
  const altered = await call('POST', '/sales', { ...input, paidCents: 999 }, cashierCookie);
  assert.equal(altered.statusCode, 409);
  const products = (await call('GET', '/products')).json<Product[]>();
  assert.equal(products.find(p => p.id === 'bolsas')?.stock.puesto, 800);
  const cash = (await call('GET', '/cash')).json();
  assert.equal(cash.expectedCents, 10500);
  assert.equal(cash.payments.efectivo, 500);
  assert.equal((await call('GET', '/sales')).json().length, 1);
  assert.equal((await call('POST', '/sales', { ...saleInput(), items: [{ productId: 'bolsas', presentationId: 'paq', quantity: 1, location: 'puesto', priceCents: 1 }] })).statusCode, 400);
});

test('concurrent attempts cannot oversell, failed baskets leave stock and cash unchanged', async () => {
  const input = () => saleInput({ paymentMethod: 'yape', paidCents: 800, items: [{ productId: 'vasos', presentationId: 'unidad', quantity: 8, location: 'puesto' }] });
  const responses = await Promise.all([call('POST', '/sales', input()), call('POST', '/sales', input())]);
  assert.deepEqual(responses.map(x => x.statusCode).sort(), [200, 409]);
  const failedBasket = saleInput({ paidCents: 1000, items: [{ productId: 'bolsas', presentationId: 'paq', quantity: 1, location: 'puesto' }, { productId: 'vasos', presentationId: 'unidad', quantity: 3, location: 'puesto' }] });
  assert.equal((await call('POST', '/sales', failedBasket)).statusCode, 409);
  assert.equal((await call('POST', '/sales', saleInput({ paidCents: 1 }))).statusCode, 400);
  const products = (await call('GET', '/products')).json<Product[]>();
  assert.equal(products.find(x => x.id === 'bolsas')?.stock.puesto, 800);
  assert.equal(products.find(x => x.id === 'vasos')?.stock.puesto, 2);
  const cash = (await call('GET', '/cash')).json();
  assert.equal(cash.expectedCents, 10500);
  assert.equal(cash.payments.yape, 800);
});

test('named documents and stored lookups validate identifiers without claiming external identity checks', async () => {
  assert.equal((await call('POST', '/sales', saleInput({ documentType: 'factura' }))).statusCode, 400);
  assert.equal((await call('GET', '/lookup/dni/12345678')).statusCode, 404);
  const response = await call('POST', '/customers', { documentType: 'DNI', document: '12345678', name: 'Cliente de prueba', address: '' });
  assert.equal(response.statusCode, 200, response.body);
  const found = (await call('GET', '/lookup/dni/12345678')).json();
  assert.equal(found.name, 'Cliente de prueba');
  assert.equal(found.source, 'registro_local');
  const supplier = await call('POST', '/suppliers', { ruc: '20999999990', name: 'Proveedor de prueba', address: '', phone: '' });
  assert.equal(supplier.statusCode, 200, supplier.body);
  supplierId = supplier.json().id;
});

test('paid purchases receive stock exactly once and deduct a single cash payment', async () => {
  const purchase = { idempotencyKey: randomUUID(), supplierId, document: 'COMPRA-DE-PRUEBA', location: 'almacen', paymentMethod: 'efectivo', paidFromCash: true, totalPaidCents: 1000, items: [{ productId: 'bolsas', presentationId: 'paq', quantity: 2, unitCostCents: 500 }] };
  const first = await call('POST', '/purchases', purchase);
  assert.equal(first.statusCode, 200, first.body);
  const retry = await call('POST', '/purchases', purchase);
  assert.equal(retry.json().id, first.json().id);
  const products = (await call('GET', '/products')).json<Product[]>();
  assert.equal(products.find(x => x.id === 'bolsas')?.stock.almacen, 200);
  const cash = (await call('GET', '/cash')).json();
  assert.equal(cash.expectedCents, 9500);
  assert.equal(cash.movements.length, 1);
  assert.equal(cash.movements[0].reason, 'Compra CP-000001');
  const invalid = await call('POST', '/purchases', { ...purchase, idempotencyKey: randomUUID(), paymentMethod: 'yape' });
  assert.equal(invalid.statusCode, 400);
  const unknownCost = await call('POST', '/purchases', { ...purchase, idempotencyKey: randomUUID(), paidFromCash: false, totalPaidCents: null, items: [{ productId: 'bolsas', presentationId: 'paq', quantity: 1, unitCostCents: null }] });
  assert.equal(unknownCost.statusCode, 200);
  assert.equal(unknownCost.json().items[0].unitCostCents, null);
});

test('cash movement retries do not duplicate incoming or outgoing cash, including another user', async () => {
  assert.equal((await call('POST', '/cash/movements', { type: 'ingreso', amountCents: 100, reason: 'Sin llave' })).statusCode, 400);
  const income = await call('POST', '/cash/movements', cashIngreso);
  assert.equal(income.statusCode, 200, income.body);
  assert.equal(income.json().expectedCents, 9600);
  const retryIncome = await call('POST', '/cash/movements', cashIngreso, cashierCookie);
  assert.equal(retryIncome.json().expectedCents, 9600);
  assert.equal(retryIncome.json().movements.length, income.json().movements.length);
  const outgoing = await call('POST', '/cash/movements', cashEgreso);
  assert.equal(outgoing.statusCode, 200, outgoing.body);
  assert.equal(outgoing.json().expectedCents, 9500);
  const retryOutgoing = await call('POST', '/cash/movements', cashEgreso, cashierCookie);
  assert.equal(retryOutgoing.json().expectedCents, 9500);
  assert.equal(retryOutgoing.json().movements.length, outgoing.json().movements.length);
  assert.equal((await call('POST', '/cash/movements', { ...cashEgreso, amountCents: 101 })).statusCode, 409);
});

test('transfers conserve units and closure separates digital receipts from expected cash', async () => {
  const transfer = await call('POST', '/stock/transfer', { productId: 'bolsas', from: 'almacen', to: 'puesto', quantityUnits: 100, reason: 'Reposición del puesto' });
  assert.equal(transfer.statusCode, 200, transfer.body);
  assert.deepEqual(transfer.json().stock, { puesto: 900, almacen: 200 });
  assert.equal((await call('POST', '/cash/movements', { idempotencyKey: randomUUID(), type: 'ingreso', amountCents: 200, reason: 'Ingreso de prueba' })).statusCode, 200);
  const closed = await call('POST', '/cash/close', { countedCents: 9650 });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().expectedCents, 9700);
  assert.equal(closed.json().differenceCents, -50);
  assert.equal(closed.json().payments.yape, 800);
  assert.equal((await call('GET', '/cash')).json(), null);
  const retryClosed = await call('POST', '/cash/movements', cashEgreso, cashierCookie);
  assert.equal(retryClosed.statusCode, 200, retryClosed.body);
  assert.equal(retryClosed.json().expectedCents, 9700);
  assert.equal(retryClosed.json().closedAt, closed.json().closedAt);
  assert.equal(retryClosed.json().movements.length, closed.json().movements.length);
  assert.equal((await call('POST', '/cash/movements', { ...cashIngreso, reason: 'Cambiar después del cierre' })).statusCode, 409);
  assert.equal((await call('POST', '/sales', saleInput())).statusCode, 409);
});

test('electronic issuance is disabled and production refuses public demonstration passwords', async () => {
  const result = await call('POST', '/fiscal/emit', { saleId: 'cualquier-venta' });
  assert.equal(result.statusCode, 409);
  assert.match(result.json().message, /desactivada/);
  await assert.rejects(buildApp({ production: true, seed: false, lookup: { token: '' } }), /Producción requiere/);
});

test('verified stock persists across restart and production invalidates old demonstration sessions', async () => {
  const temporaryRoot = resolve('tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'stockfix-persistence-'));
  let persistent: FastifyInstance | undefined;
  const previousOrigin = process.env.APP_ORIGIN;
  try {
    persistent = await buildApp({ dataDir: directory, seed: [seed[0]], lookup: { token: '' } });
    const login = await persistent.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@stockfix.local', password: 'AdminDemo2026!' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const adjusted = await persistent.inject({ method: 'POST', url: '/api/stock/adjust', headers: { cookie }, payload: { productId: 'bolsas', location: 'puesto', quantityUnits: 456, reason: 'Conteo persistente' } });
    assert.equal(adjusted.statusCode, 200, adjusted.body);
    await persistent.close();
    process.env.APP_ORIGIN = 'https://stockfix.example';
    persistent = await buildApp({ dataDir: directory, seed: false, production: true, adminPassword: 'TestPersistenceAdmin123!', cashierPassword: 'TestPersistenceCashier123!', lookup: { token: '' } });
    assert.equal((await persistent.inject({ method: 'GET', url: '/api/products', headers: { cookie } })).statusCode, 401);
    const relogin = await persistent.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@stockfix.local', password: 'TestPersistenceAdmin123!' } });
    assert.equal(relogin.statusCode, 200, relogin.body);
    assert.match(String(relogin.headers['set-cookie']), /Secure/);
    const restored = await persistent.inject({ method: 'GET', url: '/api/products', headers: { cookie: String(relogin.headers['set-cookie']).split(';')[0] } });
    assert.equal(restored.json<Product[]>()[0].stock.puesto, 456);
    assert.equal(restored.json<Product[]>()[0].stock.almacen, null);
  } finally {
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin;
    await persistent?.close();
    // Only remove the exact disposable directory created inside the workspace.
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(`${temporaryRoot}${sep}stockfix-persistence-`));
    await rm(absolute, { recursive: true, force: true });
  }
});

test('a fresh nested database creates missing parents and persists verified stock after restart', async () => {
  const temporaryRoot = resolve('tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'stockfix-fresh-nested-'));
  const dataDir = join(directory, 'not-created-yet', 'data', 'db');
  let persistent: FastifyInstance | undefined;
  try {
    assert.equal(existsSync(dirname(dataDir)), false);
    persistent = await buildApp({ dataDir, seed: [seed[0]], lookup: { token: '' } });
    assert.equal(existsSync(dataDir), true);
    const login = await persistent.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@stockfix.local', password: 'AdminDemo2026!' } });
    const adjusted = await persistent.inject({ method: 'POST', url: '/api/stock/adjust', headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, payload: { productId: 'bolsas', location: 'almacen', quantityUnits: 789, reason: 'Conteo en base nueva' } });
    assert.equal(adjusted.statusCode, 200, adjusted.body);
    await persistent.close();
    persistent = await buildApp({ dataDir, seed: false, lookup: { token: '' } });
    const relogin = await persistent.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@stockfix.local', password: 'AdminDemo2026!' } });
    const restored = await persistent.inject({ method: 'GET', url: '/api/products', headers: { cookie: String(relogin.headers['set-cookie']).split(';')[0] } });
    assert.equal(restored.json<Product[]>()[0].stock.almacen, 789);
    assert.equal(restored.json<Product[]>()[0].stock.puesto, null);
  } finally {
    await persistent?.close();
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(`${temporaryRoot}${sep}stockfix-fresh-nested-`));
    await rm(absolute, { recursive: true, force: true });
  }
});

test('static SPA fallback serves built pages but never hides API errors or exposes server files', { skip: !existsSync(resolve('dist/index.html')) }, async () => {
  const served = await buildApp({ seed: false, serveStatic: true, lookup: { token: '' } });
  try {
    const root = await served.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    assert.equal(root.statusCode, 200, root.body);
    assert.match(root.body, /<!doctype html/i);
    const page = await served.inject({ method: 'GET', url: '/ventas', headers: { accept: 'text/html' } });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<!doctype html/i);
    const api = await served.inject({ method: 'GET', url: '/api/ruta-inexistente', headers: { accept: 'text/html' } });
    assert.equal(api.statusCode, 404);
    assert.equal(api.json().message, 'Ruta no encontrada.');
    const protectedApi = await served.inject({ method: 'GET', url: '/api/products', headers: { accept: 'text/html' } });
    assert.equal(protectedApi.statusCode, 401);
    const traversal = await served.inject({ method: 'GET', url: '/..%2fserver%2fapp.ts', headers: { accept: 'text/plain' } });
    assert.equal(traversal.statusCode, 404);
    assert.doesNotMatch(traversal.body, /import Fastify/);
  } finally { await served.close(); }
});
