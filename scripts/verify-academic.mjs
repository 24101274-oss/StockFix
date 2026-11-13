import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const project = fileURLToPath(new URL('../', import.meta.url));
const evidenceDir = fileURLToPath(new URL('../../evidencias/', import.meta.url));
const sourceRoot = 'C:/Users/Julio/Documents/chamba/vanessa/fact';
const baseUrl = 'http://127.0.0.1:3341';
const webUrl = 'http://127.0.0.1:5174';
const startedAt = new Date().toISOString();
const cases = [];
let apiProcess;
let webProcess;
let cookie = '';
await mkdir(evidenceDir, { recursive: true });

async function available(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}
function launch(args, logName, extraEnv = {}) {
  const log = openSync(join(evidenceDir, logName), 'a');
  const child = spawn(process.execPath, args, {
    cwd: project, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, NODE_ENV: 'development', PORT: '3341', API_HOST: '127.0.0.1', DATA_DIR: './data/demo-db', APIPERU_TOKEN: '', APIPERU_DNI_ENABLED: 'false', APIPERU_RUC_ENABLED: 'false', NO_COLOR: '1', ...extraEnv },
  });
  closeSync(log);
  return child;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (child.exitCode !== null) throw new Error(`El servidor terminó antes de estar disponible: ${child.exitCode}`);
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Servidor no disponible: ${url}`);
}
async function call(method, path, body) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), origin: webUrl },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  return { status: response.status, data };
}
async function login() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: webUrl },
    body: JSON.stringify({ email: 'admin@stockfix.local', password: 'AdminDemo2026!' }),
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie').split(';')[0];
}
async function state(productId) {
  const products = await call('GET', '/products');
  const sales = await call('GET', '/sales');
  const cash = await call('GET', '/cash');
  const movements = await call('GET', '/stock/movements');
  return { product: products.data.find(product => product.id === productId), sales: sales.data, cash: cash.data, movements: movements.data.filter(movement => movement.productId === productId) };
}
function passed(id, title, rf, details) {
  cases.push({ id, title, requirement: rf, status: 'PASÓ', observedAt: new Date().toISOString(), ...details });
  console.log(`${id} PASÓ: ${title}`);
}
async function saveResult(status, extra = {}) {
  await writeFile(join(evidenceDir, 'verificacion-cp01-cp08.json'), JSON.stringify({ kind: 'Ejecución real de ocho casos por HTTP en copia académica', startedAt, endedAt: new Date().toISOString(), timezone: 'America/Lima', environment: { node: process.version, api: baseUrl, web: webUrl, database: 'stockfix-academico/data/demo-db', data: 'ficticios', fiscalEnabled: false, externalLookupEnabled: false }, status, cases, ...extra }, null, 2));
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await ended;
}
async function hashes() {
  const expectedSourceHashes = {
    'server/app.ts': '619A356E2447BE91986123DB2E679D21D5727AC00233E660C4F4ECAAC3848A18',
    'src/App.tsx': '6A95A29590808C2CBC0551FF826CE7C872BDDA34E7E0523C44E1D546D1605143',
    'package-lock.json': 'A8BBFB47529AB3F060640289288E91EBE70D2C15A13899FF15542E5C4054DB07',
  };
  const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase();
  const baseline = [];
  for (const [path, expected] of Object.entries(expectedSourceHashes)) {
    const current = await hash(join(sourceRoot, path));
    assert.equal(current, expected, `Se detectó cambio en el original: ${path}`);
    baseline.push({ path, sourceSha256: current, copySha256: await hash(join(project, path)), originalUnchanged: current === expected });
  }
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'data', 'tmp', 'dist', '.git'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const rel = relative(project, path).replaceAll('\\', '/');
        let sourceSha256 = null;
        try { sourceSha256 = await hash(join(sourceRoot, rel)); } catch {}
        const copySha256 = await hash(path);
        files.push({ path: rel, sourceSha256, copySha256, change: sourceSha256 === null ? 'nuevo' : sourceSha256 === copySha256 ? 'reutilizado sin cambios' : 'modificado para copia académica' });
      }
    }
  }
  await walk(project);
  await writeFile(join(evidenceDir, 'procedencia.json'), JSON.stringify({ capturedAt: new Date().toISOString(), source: sourceRoot, copy: project, previousImplementation: 'StockFix Web 0.1.0 del usuario', teamContributionThisDelivery: 'Copia aislada, datos ficticios, configuración académica y verificación; no se afirma creación íntegra desde cero.', ownLicenseFound: false, excluded: ['.env original', 'data original', 'tmp original', 'docs comerciales', '.git original', 'dist original'], dependencies: 'Copia física de node_modules, 365,2 MiB estimados antes de copiar; sin junction al original.', sourceBaseline: baseline, files }, null, 2));
}

try {
  await available(3341);
  await available(5174);
  apiProcess = launch(['--import', 'tsx', 'server/index.ts'], 'api.log');
  await ready(`${baseUrl}/api/health`, apiProcess);
  await login();
  const settings = await call('GET', '/settings');
  assert.equal(settings.data.businessName, 'StockFix Académico');
  assert.equal(settings.data.ruc, '');
  const provider = await call('GET', '/lookup/status');
  assert.equal(provider.data.configured, false);
  assert.equal(provider.data.dniEnabled, false);
  assert.equal(provider.data.rucEnabled, false);

  const barcode = `CP01-${randomUUID()}`;
  const input = { name: 'Bolsas CP-01 académicas', brand: 'DEMO', category: 'Bolsas', barcode, active: true, presentations: [{ id: 'paquete100', label: 'Paquete de 100', units: 100, priceCents: 250 }], minStockUnits: null, minStockByPresentation: [] };
  const created = await call('POST', '/products', input);
  assert.equal(created.status, 200);
  assert.deepEqual(created.data.stock, { puesto: null, almacen: null });
  const productId = created.data.id;
  const edited = await call('PATCH', `/products/${productId}`, { ...input, name: 'Bolsas CP-01 · caso académico' });
  assert.equal(edited.status, 200);
  const counted = await call('POST', '/stock/adjust', { productId, location: 'puesto', counts: [{ presentationId: 'paquete100', quantity: 10 }, { presentationId: null, quantity: 0 }], reason: 'Conteo ficticio CP-01' });
  assert.equal(counted.status, 200);
  assert.equal(counted.data.stock.puesto, 1000);
  assert.equal(counted.data.stockByPresentation.puesto.find(item => item.presentationId === 'paquete100').quantity, 10);
  passed('CP-01', 'Producto válido, edición y conteo de 10 paquetes', 'RF-01', { requests: ['POST /api/products', 'PATCH /api/products/:id', 'POST /api/stock/adjust'], httpStatus: [created.status, edited.status, counted.status], observed: counted.data });

  const countBefore = (await call('GET', '/products')).data.length;
  const duplicate = await call('POST', '/products', { ...input, name: 'Producto con código duplicado' });
  assert.equal(duplicate.status, 409);
  assert.equal((await call('GET', '/products')).data.length, countBefore);
  passed('CP-02', 'Código de barras duplicado rechazado sin crear producto', 'RF-01', { clarification: 'El SKU se genera internamente; la unicidad validada corresponde al código de barras.', httpStatus: duplicate.status, observed: duplicate.data, productsBefore: countBefore, productsAfter: countBefore });

  const invalidProduct = await call('POST', '/products', { ...input, barcode: `${barcode}-invalid`, name: '' });
  assert.equal(invalidProduct.status, 400);
  assert.equal((await call('GET', '/products')).data.length, countBefore);
  passed('CP-03', 'Nombre de producto vacío rechazado sin cambios', 'RF-01', { httpStatus: invalidProduct.status, observed: invalidProduct.data, productsBefore: countBefore, productsAfter: countBefore });

  let cash = await call('GET', '/cash');
  if (!cash.data) { cash = await call('POST', '/cash/open', { openingCents: 10000 }); assert.equal(cash.status, 200); }
  const beforeSale = await state(productId);
  const saleInput = { idempotencyKey: randomUUID(), documentType: 'ticket', customerId: null, paymentMethod: 'efectivo', paidCents: 1000, items: [{ productId, presentationId: 'paquete100', quantity: 2, location: 'puesto' }] };
  const sold = await call('POST', '/sales', saleInput);
  assert.equal(sold.status, 200);
  assert.equal(sold.data.totalCents, 500);
  assert.equal(sold.data.changeCents, 500);
  assert.equal(sold.data.status, 'PRUEBA');
  const afterSale = await state(productId);
  assert.equal(afterSale.product.stock.puesto, 800);
  assert.equal(afterSale.product.stockByPresentation.puesto.find(item => item.presentationId === 'paquete100').quantity, 8);
  assert.equal(afterSale.cash.expectedCents, beforeSale.cash.expectedCents + 500);
  assert.equal(afterSale.sales.length, beforeSale.sales.length + 1);
  passed('CP-04', 'Venta válida: total S/5, vuelto S/5 y 8 paquetes restantes', 'RF-02', { httpStatus: sold.status, request: saleInput, sale: sold.data, productAfter: afterSale.product, cashBeforeCents: beforeSale.cash.expectedCents, cashAfterCents: afterSale.cash.expectedCents });

  const failedSale = await call('POST', '/sales', { ...saleInput, idempotencyKey: randomUUID(), paidCents: 2500, items: [{ ...saleInput.items[0], quantity: 9 }] });
  assert.equal(failedSale.status, 409);
  assert.deepEqual(await state(productId), afterSale);
  passed('CP-05', 'Stock insuficiente: intento de 9 paquetes bloqueado sin efectos', 'RF-02', { httpStatus: failedSale.status, observed: failedSale.data, stateUnchanged: true, checked: ['producto/stock', 'historial de ventas', 'caja', 'movimientos del producto'] });

  const invalidQuantity = await call('POST', '/sales', { ...saleInput, idempotencyKey: randomUUID(), items: [{ ...saleInput.items[0], quantity: 0 }] });
  assert.equal(invalidQuantity.status, 400);
  assert.deepEqual(await state(productId), afterSale);
  passed('CP-06', 'Cantidad cero rechazada sin efectos', 'RF-02', { httpStatus: invalidQuantity.status, observed: invalidQuantity.data, stateUnchanged: true });

  const retry = await call('POST', '/sales', saleInput);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.id, sold.data.id);
  assert.deepEqual(await state(productId), afterSale);
  passed('CP-07', 'Doble envío del mismo intento conserva una sola venta', 'RF-02', { httpStatus: retry.status, originalSaleId: sold.data.id, retriedSaleId: retry.data.id, stateUnchanged: true });

  const previousPid = apiProcess.pid;
  await stop(apiProcess);
  apiProcess = launch(['--import', 'tsx', 'server/index.ts'], 'api.log');
  await ready(`${baseUrl}/api/health`, apiProcess);
  await login();
  const restored = await state(productId);
  assert.deepEqual(restored, afterSale);
  passed('CP-08', 'Stock, venta y caja persisten tras detener/reiniciar API', 'RF-01/RF-02', { apiPidBefore: previousPid, apiPidAfter: apiProcess.pid, stateRestored: true, productId, saleId: sold.data.id, remainingPackages: 8, remainingUnits: 800 });

  webProcess = launch(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5174'], 'vite.log');
  await ready(webUrl, webProcess);
  await hashes();
  await saveResult('PASÓ', { totals: { passed: cases.length, failed: 0 }, productForVisualReview: productId, saleForVisualReview: sold.data.id, settings: settings.data, provider: provider.data });
  await writeFile(join(evidenceDir, 'servidores.json'), JSON.stringify({ startedAt: new Date().toISOString(), project, api: { pid: apiProcess.pid, url: baseUrl }, web: { pid: webProcess.pid, url: webUrl }, purpose: 'Revisión local de StockFix Académico' }, null, 2));
  await writeFile(join(evidenceDir, 'resumen-pruebas.md'), `# Verificación HTTP de StockFix Académico\n\nEjecución terminada: ${new Date().toISOString()} (UTC). Zona de referencia del curso: America/Lima.\n\nOcho casos ejecutados y aprobados en la copia académica con datos ficticios. No representan operaciones comerciales reales.\n\n| Caso | Resultado observado | Estado |\n| --- | --- | --- |\n${cases.map(item => `| ${item.id} | ${item.title} | ${item.status} |`).join('\n')}\n\nCP-02 evalúa código de barras duplicado; el SKU se genera automáticamente. CP-08 detuvo y reinició el proceso real de la API y volvió a consultar la misma base. CP-05/06/07 compararon producto, ventas, caja y movimientos antes/después.\n\nDetalles sin cookies ni tokens: verificacion-cp01-cp08.json. Procedencia y comparación SHA-256: procedencia.json. Servicios de revisión: ${webUrl} y ${baseUrl}.\n\nLa suite heredada de server/tests debe reportarse por separado; sus resultados se guardan en los registros de validación correspondientes. Esta prueba HTTP no equivale por sí sola a una prueba visual de todos los módulos ni certifica producción.\n`);
  apiProcess.unref();
  webProcess.unref();
  console.log(`Evidencia guardada: ${evidenceDir}. Servidores activos: API ${apiProcess.pid}, WEB ${webProcess.pid}.`);
} catch (error) {
  await saveResult('FALLÓ', { error: error.stack });
  await stop(webProcess);
  await stop(apiProcess);
  console.error(error);
  process.exitCode = 1;
}
