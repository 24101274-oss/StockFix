import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { ForecastReport } from '../../shared/forecast';
import type { Product } from '../../shared/types';
import { buildApp } from '../app';
import { loadSyntheticDemo } from '../demo/store';
import { limaDate } from '../reports';
import { registerForecast } from '../forecast/routes';

let app: FastifyInstance;
let folder: string;
let admin: string;
let cashier: string;
let productId: string;
const cutoff = limaDate(new Date());
const query = `cutoff=${cutoff}`;
const get = (path: string, cookie = admin) => app.inject({ method: 'GET', url: `/api${path}`, headers: cookie ? { cookie } : {} });
async function login(role: 'admin' | 'cashier') {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: role === 'admin'
    ? { email: 'admin@stockfix.local', password: 'AdminDemo2026!' }
    : { email: 'cajero@stockfix.local', password: 'CajeroDemo2026!' } });
  assert.equal(response.statusCode, 200);
  return String(response.headers['set-cookie']).split(';')[0];
}
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'stockfix-forecast-api-'));
  await loadSyntheticDemo(join(folder, 'demo'), { seed: 'forecast-api-fixture', months: 24, asOfDate: cutoff });
  app = await buildApp({ dataDir: join(folder, 'demo'), seed: false, production: false, lookup: { token: '' } });
  admin = await login('admin');
  cashier = await login('cashier');
  const products = (await get('/products')).json<Product[]>();
  productId = products[0].id;
});
after(async () => {
  await app?.close();
  if (folder) {
    const actual = resolve(folder);
    assert.equal(dirname(actual), resolve(tmpdir()));
    assert.match(basename(actual), /^stockfix-forecast-api-/);
    await rm(actual, { recursive: true, force: true });
  }
});

// Parse the actual semicolon-delimited, quoted export, including embedded quotes
// and newlines. Assertions below compare file contents with API numeric values.
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && character === ';') { row.push(value); value = ''; }
    else if (!quoted && (character === '\r' || character === '\n')) {
      if (character === '\r' && source[index + 1] === '\n') index++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += character;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

test('DDS-11: all forecast routes require a session and administrator privileges', async () => {
  for (const path of [`/forecast?${query}`, `/forecast/export?${query}&format=csv`, `/forecast/export?${query}&format=xlsx`]) {
    assert.equal((await get(path, '')).statusCode, 401);
    assert.equal((await get(path, cashier)).statusCode, 403);
  }
});

test('DDS-11: query validation rejects unknown fields, invalid dates, future cuts and ambiguous filters', async () => {
  const tomorrow = new Date(new Date(`${cutoff}T12:00:00.000Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  for (const invalid of [
    '', 'cutoff=2026-02-30', 'cutoff=2025-02-29', 'cutoff=0000-01-01', `cutoff=${tomorrow}`,
    `${query}&horizon=0`, `${query}&horizon=13`, `${query}&horizon=1.5`, `${query}&horizon=1e0`,
    `${query}&horizon=3&horizon=4`, `${query}&location=otro`, `${query}&productId=`,
    `${query}&productId=${'x'.repeat(121)}`, `${query}&extra=true`, `${query}&format=csv`,
  ]) assert.equal((await get(`/forecast?${invalid}`)).statusCode, 400, invalid);
  assert.equal((await get(`/forecast/export?${query}&format=pdf`)).statusCode, 400);
  assert.equal((await get(`/forecast/export?${query}&unexpected=1`)).statusCode, 400);
  assert.equal((await get(`/forecast?${query}&productId=missing-product-id`)).statusCode, 404);
});

test('DDS-11: JSON returns monthly provenance, filters and a separate partial month', async () => {
  const response = await get(`/forecast?${query}&productId=${encodeURIComponent(productId)}`);
  assert.equal(response.statusCode, 200, response.body);
  const report = response.json<ForecastReport>();
  assert.deepEqual(report.query, { cutoff, horizon: 3, location: 'all', productId });
  assert.equal(report.timeZone, 'America/Lima');
  assert.equal(report.unit, 'physical-items');
  assert.equal(report.source.kind, 'synthetic');
  assert.ok(report.source.datasetId);
  assert.equal(response.headers['x-stockfix-forecast-cutoff'], cutoff);
  assert.ok(report.series.length);
  assert.ok(report.series.every(series => series.productId === productId));
  for (const series of report.series) {
    assert.ok(series.history.every(point => point.month < cutoff.slice(0, 7)));
    if (series.partial) assert.equal(series.partial.month, cutoff.slice(0, 7));
    assert.ok(series.forecast.every(point => point.month > cutoff.slice(0, 7)));
    if (series.status === 'ready') assert.equal(series.forecast.length, 3);
  }
  for (const location of ['puesto', 'almacen']) {
    const filtered = await get(`/forecast?${query}&horizon=12&location=${location}&productId=${encodeURIComponent(productId)}`);
    assert.equal(filtered.statusCode, 200, filtered.body);
    assert.equal(filtered.json<ForecastReport>().query.location, location);
    assert.equal(filtered.json<ForecastReport>().query.horizon, 12);
  }
});

test('DDS-11: CSV and XLSX preserve API figures, metadata and synthetic download labels', async () => {
  const filter = `${query}&horizon=3&location=puesto&productId=${encodeURIComponent(productId)}`;
  const json = await get(`/forecast?${filter}`);
  assert.equal(json.statusCode, 200);
  const report = json.json<ForecastReport>();
  const csv = await get(`/forecast/export?${filter}&format=csv`);
  assert.equal(csv.statusCode, 200, csv.body);
  assert.match(String(csv.headers['content-disposition']), /DATOS_SINTETICOS_DEMOSTRACION-stockfix-pronostico-/);
  assert.equal(csv.headers['x-stockfix-data-origin'], 'synthetic');
  assert.match(String(csv.headers['content-type']), /text\/csv/);
  const rows = csvRows(csv.body);
  const header = rows[0];
  const column = (title: string) => { const index = header.indexOf(title); assert.ok(index >= 0, title); return index; };
  assert.equal(rows[1][column('Origen')], 'synthetic');
  assert.equal(rows[1][column('Corte (Lima)')], cutoff);
  assert.equal(rows[1][column('Dataset')], report.source.datasetId);
  const predicted = rows.slice(1).filter(row => row[column('Tipo de dato')] === 'Pronóstico');
  const expected = report.series.flatMap(series => series.forecast.map(point => ({ productId: series.productId, presentationId: series.presentationId, ...point })));
  assert.equal(predicted.length, expected.length);
  for (const point of expected) {
    const row = predicted.find(row => row[column('ID producto')] === point.productId && row[column('ID presentación')] === point.presentationId && row[column('Mes')] === point.month);
    assert.ok(row);
    assert.equal(Number(row[column('Piezas físicas')]), point.physicalUnits);
    assert.equal(Number(row[column('Equivalente en presentaciones actuales')]), point.presentationQuantity);
  }
  const xlsx = await get(`/forecast/export?${filter}&format=xlsx`);
  assert.equal(xlsx.statusCode, 200);
  assert.match(String(xlsx.headers['content-disposition']), /DATOS_SINTETICOS_DEMOSTRACION-stockfix-pronostico-/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(xlsx.rawPayload);
  assert.deepEqual(book.worksheets.map(sheet => sheet.name), ['Reporte mensual', 'Evaluación', 'Metodología']);
  const sheet = book.worksheets[0];
  assert.deepEqual((sheet.getRow(1).values as unknown[]).slice(1), header);
  assert.equal(sheet.rowCount, rows.length);
  for (let index = 1; index < rows.length; index++) {
    const row = sheet.getRow(index + 1);
    assert.equal(String(row.getCell(column('Corte (Lima)') + 1).value), cutoff);
    if (rows[index][column('Tipo de dato')] === 'Pronóstico') {
      assert.equal(row.getCell(column('Piezas físicas') + 1).value, Number(rows[index][column('Piezas físicas')]));
      assert.equal(row.getCell(column('Equivalente en presentaciones actuales') + 1).value, Number(rows[index][column('Equivalente en presentaciones actuales')]));
    }
  }
});

test('DDS-11: forecast queries and exports leave all business state unchanged', async () => {
  const state = async () => {
    const paths = ['/products', '/sales', '/purchases', '/stock/movements', '/cash', '/cash/history'];
    const bodies = await Promise.all(paths.map(async path => { const response = await get(path); assert.equal(response.statusCode, 200); return response.body; }));
    return createHash('sha256').update(JSON.stringify(bodies)).digest('hex');
  };
  const before = await state();
  for (const path of [`/forecast?${query}`, `/forecast/export?${query}&format=csv`, `/forecast/export?${query}&format=xlsx`]) assert.equal((await get(path)).statusCode, 200);
  assert.equal(await state(), before);
});

test('DDS-11: cutoff validation follows Lima rather than the UTC calendar date', async () => {
  const fixed = Fastify();
  let currentDate = new Date('2026-11-27T04:30:00.000Z');
  fixed.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : Number((error as { statusCode?: number }).statusCode) || 500).send({ message: error instanceof Error ? error.message : 'Error' }));
  registerForecast(fixed, {
    requireAdmin: async () => ({ id: 'fixture-admin', name: 'Fixture', email: 'fixture@example.test', role: 'admin', active: true }),
    loadProducts: async () => [], loadSales: async () => [], loadManifest: async () => null,
    now: () => currentDate,
  });
  try {
    const allowed = await fixed.inject({ method: 'GET', url: '/api/forecast?cutoff=2026-11-26' });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json<ForecastReport>().source.kind, 'recorded');
    const future = await fixed.inject({ method: 'GET', url: '/api/forecast?cutoff=2026-11-27' });
    assert.equal(future.statusCode, 400);
    currentDate = new Date('9999-12-31T17:00:00.000Z');
    assert.equal((await fixed.inject({ method: 'GET', url: '/api/forecast?cutoff=9999-01-01&horizon=11' })).statusCode, 200);
    assert.equal((await fixed.inject({ method: 'GET', url: '/api/forecast?cutoff=9999-12-01&horizon=1' })).statusCode, 400);
  } finally { await fixed.close(); }
});
