import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, readFile, readdir, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Product, Sale } from '../../shared/types';
import type { SyntheticOptions } from '../../shared/demo-dataset';
import { generateSyntheticDataset } from '../demo/dataset';
import { loadSyntheticDemo } from '../demo/store';
import { parseDemoSeedArgs } from '../demo/cli';
import { buildApp } from '../app';

const options: SyntheticOptions = { seed: 'store-test-2026', asOfDate: '2026-11-26', months: 24 };
let temporary: string;
before(async () => { temporary = await mkdtemp(join(tmpdir(), 'stockfix-synthetic-store-')); });
after(async () => {
  const actual = resolve(temporary);
  assert.equal(dirname(actual).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(basename(actual).startsWith('stockfix-synthetic-store-'));
  assert.ok(actual.startsWith(resolve(tmpdir()) + sep));
  await rm(actual, { recursive: true, force: true });
});

test('DDS-10: import is transactional, repeatable and rejects a changed configuration without resetting records', async () => {
  const target = join(temporary, 'first');
  const expected = generateSyntheticDataset(options);
  const created = await loadSyntheticDemo(target, options);
  assert.equal(created.action, 'created');
  assert.deepEqual(created.manifest, expected.manifest);
  const markerBefore = await readFile(created.manifestPath, 'utf8');
  const marker = JSON.parse(markerBefore);
  assert.equal(marker.status, 'ready');
  assert.equal(marker.dataSha256, expected.manifest.dataSha256);
  const db = new PGlite(target);
  try {
    await db.waitReady;
    const identity = await db.query<{ data: unknown; loaded_at: string }>('SELECT data,loaded_at FROM demo_datasets WHERE id=$1', ['active']);
    assert.deepEqual(identity.rows[0].data, expected.manifest);
    assert.equal(identity.rows[0].loaded_at, marker.loadedAt);
    for (const [table, count] of [['products', expected.products.length], ['sales', expected.sales.length], ['purchases', expected.purchases.length], ['stock_movements', expected.stockMovements.length], ['cash_sessions', expected.cashSessions.length]] as const) {
      assert.equal((await db.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, count);
    }
    const counters = await db.query<{ name: string; value: number }>('SELECT name,value FROM counters');
    assert.equal(counters.rows.find(row => row.name === 'sale')?.value, expected.sales.length);
    assert.equal(counters.rows.find(row => row.name === 'purchase')?.value, expected.purchases.length);
  } finally { await db.close(); }
  assert.equal((await loadSyntheticDemo(target, options)).action, 'unchanged');
  assert.equal(await readFile(created.manifestPath, 'utf8'), markerBefore);
  await assert.rejects(loadSyntheticDemo(target, { ...options, seed: 'another-seed' }), /otra configuración/);
  assert.equal(await readFile(created.manifestPath, 'utf8'), markerBefore);
  assert.equal((await loadSyntheticDemo(target, options)).action, 'unchanged');
});

test('DDS-10: the app can read imported history and repeat loading preserves later sales, stock and cash across restart', async () => {
  const target = join(temporary, 'app');
  const loaded = await loadSyntheticDemo(target, options);
  const password = 'SyntheticStoreFixture2026!';
  let app = await buildApp({ dataDir: target, seed: false, adminPassword: password, production: false, lookup: { token: '' } });
  const login = async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@stockfix.local', password } });
    assert.equal(response.statusCode, 200, response.body);
    return String(response.headers['set-cookie']).split(';')[0];
  };
  let chosenId = '';
  let expectedStock = 0;
  let expectedCash = 0;
  try {
    const cookie = await login();
    assert.equal((await app.inject({ method: 'GET', url: '/api/demo-dataset' })).statusCode, 401);
    const metadata = await app.inject({ method: 'GET', url: '/api/demo-dataset', headers: { cookie } });
    assert.equal(metadata.statusCode, 200);
    assert.deepEqual(metadata.json().dataset, loaded.manifest);
    const download = await app.inject({ method: 'GET', url: '/api/demo-dataset/manifest.json', headers: { cookie } });
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.json(), loaded.manifest);
    const exported = await app.inject({ method: 'GET', url: '/api/reports/sales/export?format=csv', headers: { cookie } });
    assert.equal(exported.statusCode, 200);
    assert.match(String(exported.headers['content-disposition']), /DATOS_SINTETICOS_DEMOSTRACION-/);
    assert.equal(exported.headers['x-stockfix-data-origin'], 'synthetic');
    const sales = await app.inject({ method: 'GET', url: '/api/sales', headers: { cookie } });
    assert.equal(sales.json<Sale[]>().length, loaded.manifest.counts.sales);
    const products = (await app.inject({ method: 'GET', url: '/api/products', headers: { cookie } })).json<Product[]>();
    const product = products.find(p => p.stockByPresentation?.puesto?.some(count => count.presentationId !== null && count.quantity > 0));
    assert.ok(product, 'the demo needs a sellable closed pack');
    const count = product.stockByPresentation!.puesto!.find(row => row.presentationId !== null && row.quantity > 0)!;
    const presentation = product.presentations.find(row => row.id === count.presentationId)!;
    chosenId = product.id;
    expectedStock = product.stock.puesto! - presentation.units;
    expectedCash = presentation.priceCents;
    const opened = await app.inject({ method: 'POST', url: '/api/cash/open', headers: { cookie }, payload: { openingCents: 0 } });
    assert.equal(opened.statusCode, 200, opened.body);
    const sold = await app.inject({ method: 'POST', url: '/api/sales', headers: { cookie }, payload: { idempotencyKey: 'synthetic-store-later-sale', documentType: 'ticket', customerId: null, paymentMethod: 'efectivo', paidCents: presentation.priceCents, items: [{ productId: product.id, presentationId: presentation.id, quantity: 1, location: 'puesto' }] } });
    assert.equal(sold.statusCode, 200, sold.body);
    assert.equal(sold.json<Sale>().number, `PR-${String(loaded.manifest.counts.sales + 1).padStart(6, '0')}`);
  } finally { await app.close(); }
  assert.equal((await loadSyntheticDemo(target, options)).action, 'unchanged');
  app = await buildApp({ dataDir: target, seed: false, adminPassword: password, production: false, lookup: { token: '' } });
  try {
    const cookie = await login();
    const products = (await app.inject({ method: 'GET', url: '/api/products', headers: { cookie } })).json<Product[]>();
    assert.equal(products.find(row => row.id === chosenId)?.stock.puesto, expectedStock);
    const cash = await app.inject({ method: 'GET', url: '/api/cash', headers: { cookie } });
    assert.equal(cash.json().expectedCents, expectedCash);
    assert.equal((await app.inject({ method: 'GET', url: '/api/sales', headers: { cookie } })).json<Sale[]>().length, loaded.manifest.counts.sales + 1);
  } finally { await app.close(); }
});

test('DDS-10: protected and unrecognized destinations are rejected before creating or opening a database', async () => {
  const unknown = join(temporary, 'unknown');
  await mkdir(unknown);
  await writeFile(join(unknown, 'sentinel.txt'), 'do not touch');
  await assert.rejects(loadSyntheticDemo(unknown, options), /base no reconocida/);
  assert.deepEqual(await readdir(unknown), ['sentinel.txt']);
  assert.equal(await readFile(join(unknown, 'sentinel.txt'), 'utf8'), 'do not touch');
  assert.equal(existsSync(unknown + '.stockfix-synthetic.json'), false);
  const protectedDir = fileURLToPath(new URL('../../data/demo-db', import.meta.url));
  await assert.rejects(loadSyntheticDemo(protectedDir, options), /Destino protegido/);
  await assert.rejects(loadSyntheticDemo(join(protectedDir, 'nested'), options), /Destino protegido/);
  const misleadingChild = join(protectedDir, '..forecast');
  const childExisted = existsSync(misleadingChild);
  const markerExisted = existsSync(misleadingChild + '.stockfix-synthetic.json');
  await assert.rejects(loadSyntheticDemo(misleadingChild, options), /Destino protegido/);
  assert.equal(existsSync(misleadingChild), childExisted);
  assert.equal(existsSync(misleadingChild + '.stockfix-synthetic.json'), markerExisted);
  await assert.rejects(loadSyntheticDemo('memory://not-a-local-destination', options), /carpeta local/);
  const invalid = join(temporary, 'invalid-date');
  await assert.rejects(loadSyntheticDemo(invalid, { ...options, asOfDate: '2026-02-30' }));
  assert.equal(existsSync(invalid), false);
  assert.equal(existsSync(invalid + '.stockfix-synthetic.json'), false);
});

test('DDS-10: interrupted or mismatched ownership never restarts or replaces an existing destination', async () => {
  const target = join(temporary, 'interrupted');
  await mkdir(target);
  await writeFile(join(target, 'sentinel.txt'), 'unchanged');
  const dataset = generateSyntheticDataset(options);
  const marker = { kind: 'stockfix-synthetic-dataset', version: 1, status: 'initializing', dataDir: await realpath(target), config: options, dataSha256: dataset.manifest.dataSha256, manifest: dataset.manifest, loadedAt: '2026-11-26T12:00:00.000Z' };
  const manifestPath = target + '.stockfix-synthetic.json';
  await writeFile(manifestPath, JSON.stringify(marker));
  await assert.rejects(loadSyntheticDemo(target, options), /no terminó/);
  assert.deepEqual(await readdir(target), ['sentinel.txt']);
  const mismatch = JSON.stringify({ ...marker, status: 'ready', dataSha256: '0'.repeat(64) });
  await writeFile(manifestPath, mismatch);
  await assert.rejects(loadSyntheticDemo(target, options), /otra configuración/);
  assert.equal(await readFile(manifestPath, 'utf8'), mismatch);
  assert.equal(await readFile(join(target, 'sentinel.txt'), 'utf8'), 'unchanged');
});

test('DDS-10: CLI requires an explicit cut and rejects missing, repeated or unknown flags', () => {
  assert.throws(() => parseDemoSeedArgs([]), /--as-of/);
  assert.throws(() => parseDemoSeedArgs(['--as-of']), /Falta el valor/);
  assert.throws(() => parseDemoSeedArgs(['--as-of', '2026-11-26', '--as-of', '2026-11-27']), /repetida/);
  assert.throws(() => parseDemoSeedArgs(['--delete', 'yes']), /desconocida/);
  const parsed = parseDemoSeedArgs(['--as-of=2026-11-26', '--data-dir', 'custom-isolated', '--seed', 'fixture', '--months', '24']);
  assert.deepEqual(parsed, { dataDir: 'custom-isolated', options: { seed: 'fixture', asOfDate: '2026-11-26', months: 24 } });
});
