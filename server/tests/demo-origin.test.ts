import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadSyntheticDemo } from '../demo/store';
import { SYNTHETIC_DATA_LABEL } from '../../shared/demo-dataset';

let ordinary: FastifyInstance;
let synthetic: FastifyInstance;
let folder: string;
let ordinaryAdmin: string;
let syntheticAdmin: string;
let cashier: string;
const get = (app: FastifyInstance, path: string, cookie = '') => app.inject({ method: 'GET', url: `/api${path}`, headers: cookie ? { cookie } : {} });
async function login(app: FastifyInstance, role: 'admin' | 'cashier') {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: role === 'admin'
    ? { email: 'admin@stockfix.local', password: 'AdminDemo2026!' }
    : { email: 'cajero@stockfix.local', password: 'CajeroDemo2026!' } });
  assert.equal(response.statusCode, 200);
  return String(response.headers['set-cookie']).split(';')[0];
}
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'stockfix-origin-'));
  ordinary = await buildApp({ seed: false, lookup: { token: '' } });
  await loadSyntheticDemo(join(folder, 'demo'), { seed: 'origin-integration', months: 12, asOfDate: '2026-11-26' });
  synthetic = await buildApp({ dataDir: join(folder, 'demo'), seed: false, lookup: { token: '' } });
  ordinaryAdmin = await login(ordinary, 'admin');
  syntheticAdmin = await login(synthetic, 'admin');
  cashier = await login(synthetic, 'cashier');
});
after(async () => {
  await ordinary?.close();
  await synthetic?.close();
  if (folder) {
    const target = resolve(folder);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.match(basename(target), /^stockfix-origin-/);
    await rm(target, { recursive: true, force: true });
  }
});

test('DDS-10: an ordinary database has no synthetic provenance and retains export names', async () => {
  assert.equal((await get(ordinary, '/demo-dataset')).statusCode, 401);
  const metadata = await get(ordinary, '/demo-dataset', ordinaryAdmin);
  assert.deepEqual(metadata.json(), { dataset: null });
  assert.equal(metadata.headers['x-stockfix-data-origin'], undefined);
  assert.equal((await get(ordinary, '/demo-dataset/manifest.json', ordinaryAdmin)).statusCode, 404);
  const exported = await get(ordinary, '/reports/inventory/export?format=csv', ordinaryAdmin);
  assert.equal(exported.statusCode, 200);
  assert.doesNotMatch(String(exported.headers['content-disposition']), /SINTETICOS/);
});

test('DDS-10: cashier can identify synthetic data and download its manifest without gaining reporting privileges', async () => {
  assert.equal((await get(synthetic, '/demo-dataset/manifest.json')).statusCode, 401);
  const metadata = await get(synthetic, '/demo-dataset', cashier);
  assert.equal(metadata.statusCode, 200);
  assert.equal(metadata.json().dataset.label, SYNTHETIC_DATA_LABEL);
  assert.match(metadata.json().dataset.id, /^synthetic-v1-/);
  const manifest = await get(synthetic, '/demo-dataset/manifest.json', cashier);
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.json().dataSha256, metadata.json().dataset.dataSha256);
  assert.match(String(manifest.headers['content-disposition']), /DATOS_SINTETICOS_DEMOSTRACION-/);
  assert.equal((await get(synthetic, '/reports/inventory/export?format=csv', cashier)).statusCode, 403);
});

test('DDS-10: CSV and XLSX exports identify their synthetic origin while preserving their columns', async () => {
  const paths = ['/reports/inventory/export', '/reports/sales/export', '/reports/stock/export'];
  for (const path of paths) {
    const plain = await get(ordinary, `${path}?format=csv`, ordinaryAdmin);
    const csv = await get(synthetic, `${path}?format=csv`, syntheticAdmin);
    assert.equal(csv.statusCode, 200, csv.body);
    assert.equal(csv.body.split('\r\n')[0], plain.body.split('\r\n')[0]);
    assert.equal(csv.headers['x-stockfix-data-origin'], 'synthetic');
    assert.match(String(csv.headers['content-disposition']), /DATOS_SINTETICOS_DEMOSTRACION-/);
    const xlsx = await get(synthetic, `${path}?format=xlsx`, syntheticAdmin);
    assert.equal(xlsx.statusCode, 200);
    assert.equal(xlsx.headers['x-stockfix-data-origin'], 'synthetic');
    assert.match(String(xlsx.headers['content-disposition']), /DATOS_SINTETICOS_DEMOSTRACION-/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.rawPayload);
    assert.ok(workbook.worksheets.length > 0);
    assert.ok(workbook.worksheets[0].rowCount > 1);
  }
});
