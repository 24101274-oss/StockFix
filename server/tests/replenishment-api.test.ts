import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { Product } from '../../shared/types';
import type { ReplenishmentReport, ReplenishmentScenario, ScenarioReceipt } from '../../shared/replenishment';
import { buildApp } from '../app';
import { loadSyntheticDemo } from '../demo/store';
import { limaDate } from '../reports';
import { registerReplenishment } from '../replenishment/routes';

let app: FastifyInstance;
let folder: string;
let admin: string;
let cashier: string;
let product: Product;
let inactiveId: string;
let noUnitId: string;
const today = limaDate(new Date());
const monthStart = (offset: number) => {
  const date = new Date(`${today.slice(0, 7)}-01T12:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
};
const post = (path: string, payload: unknown, cookie = admin, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: `/api${path}`, headers: { ...(cookie ? { cookie } : {}), ...headers }, payload: payload as object });
const get = (path: string) => app.inject({ method: 'GET', url: `/api${path}`, headers: { cookie: admin } });
async function login(role: 'admin' | 'cashier') {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: role === 'admin'
    ? { email: 'admin@stockfix.local', password: 'AdminDemo2026!' }
    : { email: 'cajero@stockfix.local', password: 'CajeroDemo2026!' } });
  assert.equal(response.statusCode, 200);
  return String(response.headers['set-cookie']).split(';')[0];
}
const scenario = (): ReplenishmentScenario => ({ productId: product.id, horizon: 3, leadTimeDays: 14, reservePercent: 10, receipts: [], bridgeDemand: [] });
const receipt = (changes: Partial<ScenarioReceipt> = {}): ScenarioReceipt => ({ id: 'receipt-one', productId: product.id, presentationId: product.presentations.find(p => p.units > 1)!.id, location: 'puesto', quantity: 2, expectedOn: monthStart(1), status: 'pending', ...changes });

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'stockfix-replenishment-api-'));
  await loadSyntheticDemo(join(folder, 'demo'), { seed: 'replenishment-api-fixture', months: 24, asOfDate: today });
  app = await buildApp({ dataDir: join(folder, 'demo'), seed: false, production: false, lookup: { token: '' } });
  admin = await login('admin');
  cashier = await login('cashier');
  const products = (await get('/products')).json<Product[]>();
  product = products.find(item => item.presentations.some(p => p.units > 1) && item.presentations.some(p => p.units === 1))!;
  assert.ok(product);
  for (const active of [false, true]) {
    const created = await post('/products', { name: active ? 'Fixture solo paquetes' : 'Fixture inactivo', brand: 'Fixture', category: 'Pruebas', barcode: null, active, presentations: [{ id: 'fixture-pack', label: 'Paquete de prueba', units: 10, priceCents: 100 }] });
    assert.equal(created.statusCode, 200, created.body);
    if (active) noUnitId = created.json<Product>().id;
    else inactiveId = created.json<Product>().id;
  }
});
after(async () => {
  await app?.close();
  if (folder) {
    const actual = resolve(folder);
    assert.equal(dirname(actual), resolve(tmpdir()));
    assert.match(basename(actual), /^stockfix-replenishment-api-/);
    await rm(actual, { recursive: true, force: true });
  }
});

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && char === ';') { row.push(value); value = ''; }
    else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && source[index + 1] === '\n') index++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

test('DDS-12: preview and export require administrator auth and reject cross-site POST requests', async () => {
  for (const path of ['/replenishment/preview', '/replenishment/export?format=csv', '/replenishment/export?format=xlsx']) {
    const payload = path.includes('export') ? { scenario: scenario(), snapshot: '0'.repeat(64) } : scenario();
    assert.equal((await post(path, payload, '')).statusCode, 401);
    assert.equal((await post(path, payload, cashier)).statusCode, 403);
  }
  assert.equal((await post('/replenishment/preview', scenario(), admin, { origin: 'https://otro.example.test' })).statusCode, 403);
});

test('DDS-12: strict bodies, ranges, dates and receipt IDs reject ambiguous or historical inputs', async () => {
  for (const changes of [
    { asOfDate: '2020-01-01' }, { cutoff: '2020-01-01' }, { stock: 10 }, { unknown: true },
    { horizon: 0 }, { horizon: 13 }, { horizon: '3' }, { horizon: 1.5 },
    { leadTimeDays: -1 }, { leadTimeDays: 366 }, { reservePercent: -1 }, { reservePercent: 101 }, { reservePercent: 0.001 },
    { productId: '' }, { productId: 'x'.repeat(121) },
    { receipts: [receipt({ quantity: 0 })] }, { receipts: [receipt({ quantity: 1.2 })] }, { receipts: [receipt({ quantity: 1_000_000_001 })] },
    { receipts: [receipt({ expectedOn: '2026-02-30' })] }, { receipts: [receipt({ expectedOn: '0000-01-01' })] },
    { receipts: [receipt(), receipt({ id: ' receipt-one ' })] },
    { receipts: Array.from({ length: 101 }, (_, index) => receipt({ id: `entry-${index}` })) },
    { bridgeDemand: [{ productId: product.id, presentationId: null, location: 'puesto', quantity: -1 }] },
    { bridgeDemand: Array.from({ length: 201 }, () => ({ productId: product.id, presentationId: null, location: 'puesto', quantity: 0 })) },
  ]) assert.equal((await post('/replenishment/preview', { ...scenario(), ...changes })).statusCode, 400, JSON.stringify(changes).slice(0, 200));
  assert.equal((await post('/replenishment/preview?cutoff=2020-01-01', scenario())).statusCode, 400);
  assert.equal((await post('/replenishment/preview', { ...scenario(), reservePercent: 0.29 })).statusCode, 200);
  assert.equal((await post('/replenishment/export?format=pdf', { scenario: scenario(), snapshot: '0'.repeat(64) })).statusCode, 400);
  assert.equal((await post('/replenishment/export?extra=1', { scenario: scenario(), snapshot: '0'.repeat(64) })).statusCode, 400);
  assert.equal((await post('/replenishment/export', { scenario: scenario(), snapshot: 'invalid' })).statusCode, 400);
  assert.equal((await post('/replenishment/export', { scenario: scenario(), snapshot: '0'.repeat(64), plan: {} })).statusCode, 400);
});

test('DDS-12: active references and the one loose-unit pool are validated before planning', async () => {
  for (const invalidProduct of ['missing-product', inactiveId]) {
    assert.equal((await post('/replenishment/preview', { ...scenario(), productId: invalidProduct })).statusCode, 404);
    assert.equal((await post('/replenishment/preview', { ...scenario(), receipts: [receipt({ productId: invalidProduct })] })).statusCode, 404);
    assert.equal((await post('/replenishment/preview', { ...scenario(), bridgeDemand: [{ productId: invalidProduct, presentationId: null, location: 'puesto', quantity: 0 }] })).statusCode, 404);
  }
  assert.equal((await post('/replenishment/preview', { ...scenario(), receipts: [receipt({ presentationId: 'missing-presentation' })] })).statusCode, 400);
  assert.equal((await post('/replenishment/preview', { ...scenario(), receipts: [receipt({ productId: noUnitId, presentationId: null })] })).statusCode, 400);
  const unitId = product.presentations.find(p => p.units === 1)!.id;
  const duplicate = { ...scenario(), bridgeDemand: [
    { productId: product.id, presentationId: null, location: 'puesto', quantity: 1 },
    { productId: product.id, presentationId: unitId, location: 'puesto', quantity: 1 },
  ] };
  assert.equal((await post('/replenishment/preview', duplicate)).statusCode, 400);
});

test('DDS-12: JSON balances include pending receipts once, exclude received/cancelled and carry conditional stock', async () => {
  const pack = product.presentations.find(p => p.units > 1)!;
  const input = { ...scenario(), receipts: [
    receipt({ id: 'scheduled', quantity: 2 }), receipt({ id: 'late', quantity: 4, expectedOn: monthStart(1).slice(0, 8) + '15' }),
    receipt({ id: 'received', quantity: 999, status: 'received' }), receipt({ id: 'cancelled', quantity: 999, status: 'cancelled' }),
  ], bridgeDemand: [{ productId: product.id, presentationId: pack.id, location: 'puesto' as const, quantity: 1 }] };
  const response = await post('/replenishment/preview', input);
  assert.equal(response.statusCode, 200, response.body);
  const report = response.json<ReplenishmentReport>();
  assert.equal(report.asOfDate, today);
  assert.equal(report.firstMonth, monthStart(1).slice(0, 7));
  assert.equal(report.source.kind, 'synthetic');
  assert.match(report.snapshot, /^[a-f\d]{64}$/);
  const { snapshot, ...plan } = report;
  assert.equal(snapshot, createHash('sha256').update(JSON.stringify(plan)).digest('hex'));
  assert.equal((await post('/replenishment/preview', input)).json<ReplenishmentReport>().snapshot, snapshot);
  assert.equal(report.receiptDispositions.find(r => r.id === 'scheduled')?.status, 'scheduled');
  assert.equal(report.receiptDispositions.find(r => r.id === 'late')?.eligibleMonth, monthStart(2).slice(0, 7));
  assert.equal(report.receiptDispositions.find(r => r.id === 'received')?.status, 'received-excluded');
  assert.equal(report.receiptDispositions.find(r => r.id === 'cancelled')?.status, 'cancelled-excluded');
  const item = report.items.find(row => row.presentationId === pack.id)!;
  assert.equal(item.status, 'ready');
  assert.equal(item.afterBridge.puesto, Math.max(0, item.initialStock.puesto! - 1));
  assert.equal(item.months.reduce((sum, month) => sum + month.receipts.puesto, 0), 6);
  for (let index = 0; index < item.months.length; index++) {
    const month = item.months[index];
    assert.deepEqual(month.opening, index === 0 ? item.afterBridge : item.months[index - 1].closingIfRecommendations);
    for (const location of ['puesto', 'almacen'] as const) {
      assert.equal(month.available[location], month.opening[location] + month.receipts[location]);
      const afterTransfer = month.available[location] + (location === 'puesto' ? month.transferFromWarehouse : -month.transferFromWarehouse);
      assert.equal(month.demand[location], Math.ceil(month.demandPhysicalUnits[location] / item.unitsPerPresentation));
      assert.equal(month.reserve[location], Math.ceil(month.demand[location] * input.reservePercent / 100));
      assert.equal(month.suggestedPurchase[location], Math.max(0, month.demand[location] + month.reserve[location] - afterTransfer));
      assert.equal(month.closingWithoutThisPurchase[location], Math.max(0, afterTransfer - month.demand[location]));
      assert.equal(month.uncoveredDemand[location], Math.max(0, month.demand[location] - afterTransfer));
      assert.equal(month.closingIfRecommendations[location], afterTransfer + month.suggestedPurchase[location] - month.demand[location]);
    }
  }
});

test('DDS-12: CSV and XLSX agree with the plan and preserve source, unknown counts and conditional labels', async () => {
  const response = await post('/replenishment/preview', scenario());
  assert.equal(response.statusCode, 200);
  const report = response.json<ReplenishmentReport>();
  const body = { scenario: report.scenario, snapshot: report.snapshot };
  const csv = await post('/replenishment/export?format=csv', body);
  assert.equal(csv.statusCode, 200, csv.body);
  assert.match(String(csv.headers['content-disposition']), /DATOS_SINTETICOS_DEMOSTRACION-stockfix-reposicion-/);
  assert.equal(csv.headers['x-stockfix-data-origin'], 'synthetic');
  const rows = csvRows(csv.body), header = rows[0];
  const column = (title: string) => { const found = header.indexOf(title); assert.ok(found >= 0, title); return found; };
  assert.equal(rows[1][column('Fecha del plan (Lima)')], today);
  assert.equal(rows[1][column('Huella del plan')], report.snapshot);
  const monthly = rows.filter(row => row[column('Tipo de fila')] === 'Proyección mensual condicional');
  assert.equal(monthly.length, report.items.reduce((sum, item) => sum + item.months.length * 2, 0));
  for (const item of report.items) for (const month of item.months) for (const location of ['puesto', 'almacen'] as const) {
    const row = monthly.find(row => row[column('ID producto')] === item.productId && row[column('ID presentación (vacío = sueltas)')] === (item.presentationId ?? '') && row[column('Mes')] === month.month && row[column('Ubicación')] === location);
    assert.ok(row);
    assert.equal(Number(row[column('Compra sugerida')]), month.suggestedPurchase[location]);
    assert.equal(Number(row[column('Cierre si se siguen recomendaciones')]), month.closingIfRecommendations[location]);
  }
  const xlsx = await post('/replenishment/export?format=xlsx', body);
  assert.equal(xlsx.statusCode, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(xlsx.rawPayload);
  assert.deepEqual(book.worksheets.map(sheet => sheet.name), ['Plan mensual', 'Entradas declaradas', 'Supuestos']);
  assert.deepEqual((book.worksheets[0].getRow(1).values as unknown[]).slice(1), header);
  assert.equal(book.worksheets[0].rowCount, rows.length);
  const unknown = (await post('/replenishment/preview', { ...scenario(), productId: noUnitId })).json<ReplenishmentReport>();
  assert.ok(unknown.items.every(item => item.status === 'unknown-stock' && item.initialStock.puesto === null && !item.months.length));
  const unknownCSV = await post('/replenishment/export?format=csv', { scenario: unknown.scenario, snapshot: unknown.snapshot });
  assert.equal(unknownCSV.statusCode, 200);
  const unknownRows = csvRows(unknownCSV.body).filter(row => row[column('Tipo de fila')] === 'Base y consumo puente');
  assert.ok(unknownRows.length);
  assert.ok(unknownRows.every(row => row[column('Stock inicial real')] === ''));
});

test('DDS-12: export rejects a stale stock snapshot and succeeds after recalculation', async () => {
  const old = (await post('/replenishment/preview', scenario())).json<ReplenishmentReport>();
  const current = (await get('/products')).json<Product[]>().find(p => p.id === product.id)!;
  const pack = current.presentations.find(p => p.units > 1)!;
  const counts = current.stockByPresentation!.puesto!.map(count => ({ ...count, quantity: count.quantity + (count.presentationId === pack.id ? 1 : 0) }));
  const adjusted = await post('/stock/adjust', { productId: product.id, location: 'puesto', counts, reason: 'Prueba aislada de huella del plan' });
  assert.equal(adjusted.statusCode, 200, adjusted.body);
  const stale = await post('/replenishment/export?format=csv', { scenario: old.scenario, snapshot: old.snapshot });
  assert.equal(stale.statusCode, 409);
  assert.match(stale.json().message, /Los datos cambiaron/);
  const fresh = (await post('/replenishment/preview', scenario())).json<ReplenishmentReport>();
  assert.notEqual(fresh.snapshot, old.snapshot);
  assert.equal((await post('/replenishment/export?format=csv', { scenario: fresh.scenario, snapshot: fresh.snapshot })).statusCode, 200);
});

test('DDS-12: preview and both exports do not change products, stock, sales, purchases or cash', async () => {
  const state = async () => {
    const bodies = await Promise.all(['/products', '/stock/movements', '/sales', '/purchases', '/cash', '/cash/history'].map(async path => { const response = await get(path); assert.equal(response.statusCode, 200); return response.body; }));
    return createHash('sha256').update(JSON.stringify(bodies)).digest('hex');
  };
  const before = await state();
  const report = (await post('/replenishment/preview', scenario())).json<ReplenishmentReport>();
  for (const format of ['csv', 'xlsx']) assert.equal((await post(`/replenishment/export?format=${format}`, { scenario: report.scenario, snapshot: report.snapshot })).statusCode, 200);
  assert.equal(await state(), before);
});

test('DDS-12: the server fixes the Lima date and rejects out-of-calendar horizons and lead times', async () => {
  const fixed = Fastify();
  let currentDate = new Date('2026-11-27T04:30:00.000Z');
  fixed.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : Number((error as { statusCode?: number }).statusCode) || 500).send({ message: error instanceof Error ? error.message : 'Error' }));
  registerReplenishment(fixed, {
    requireAdmin: async () => ({ id: 'fixture', name: 'Fixture', email: 'fixture@example.test', role: 'admin', active: true }),
    loadProducts: async () => [], loadSales: async () => [], loadManifest: async () => null, now: () => currentDate,
  });
  try {
    const response = await fixed.inject({ method: 'POST', url: '/api/replenishment/preview', payload: {} });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<ReplenishmentReport>().asOfDate, '2026-11-26');
    assert.equal(response.json<ReplenishmentReport>().scenario.leadTimeDays, 14);
    currentDate = new Date('9999-12-01T17:00:00.000Z');
    assert.equal((await fixed.inject({ method: 'POST', url: '/api/replenishment/preview', payload: {} })).statusCode, 400);
    currentDate = new Date('9999-11-01T17:00:00.000Z');
    assert.equal((await fixed.inject({ method: 'POST', url: '/api/replenishment/preview', payload: { horizon: 1, leadTimeDays: 365 } })).statusCode, 400);
  } finally { await fixed.close(); }
});
