import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Product, Sale, StockMovement, Summary, User } from '../../shared/types.js';
import { buildApp } from '../app.js';
import { buildSummary, csvCell, filterInventory, filterSales, filterStockMovements, inventoryExportSchema, limaDate, registerReports, salesExportSchema, stockExportSchema } from '../reports.js';

const baseProduct: Product = { id: 'bolsas', sku: 'P-001', name: 'Bolsas PRUEBA', brand: 'ALFA', category: 'Bolsas', barcode: null, active: true, stock: { puesto: 1000, almacen: null }, minStockUnits: 1000, presentations: [{ id: 'paq', label: 'Paquete de 100', units: 100, priceCents: 250 }], sourceNotes: [] };
const products: Product[] = [baseProduct,
  { ...baseProduct, id: 'vasos', sku: 'P-002', name: 'Vasos PRUEBA', brand: '', category: 'Vasos', minStockUnits: null, stock: { puesto: 0, almacen: 0 }, presentations: [] },
  { ...baseProduct, id: 'inactivo', sku: 'P-003', active: false, stock: { puesto: 0, almacen: 0 } },
  { ...baseProduct, id: 'legado', sku: 'P-004', minStockUnits: undefined, stock: { puesto: 0, almacen: null } },
];
function saleAt(createdAt: string, changes: Partial<Sale> = {}): Sale {
  return { id: randomUUID(), number: 'PR-000001', createdAt, documentType: 'boleta', status: 'PRUEBA', customer: null, paymentMethod: 'efectivo', userName: 'Cajero PRUEBA', totalCents: 500, paidCents: 1000, changeCents: 500, cancelled: false, items: [{ productId: baseProduct.id, name: baseProduct.name, presentationId: 'paq', presentationLabel: 'Paquete de 100', quantity: 2, units: 200, location: 'puesto', unitPriceCents: 250, totalCents: 500 }], ...changes };
}
const boundarySales = [
  saleAt('2026-11-01T04:59:59.999Z'),
  saleAt('2026-11-01T05:00:00.000Z', { number: 'PR-000002' }),
  saleAt('2026-11-02T04:59:59.999Z', { number: 'PR-000003', cancelled: true }),
  saleAt('2026-11-02T05:00:00.000Z', { number: 'PR-000004', paymentMethod: 'yape', documentType: 'ticket' }),
];

test('summary uses Lima month/day boundaries, physical pieces and distinct sales; excludes cancelled records', () => {
  const duplicate = saleAt('2026-11-01T05:30:00.000Z', { items: [boundarySales[1].items[0], boundarySales[1].items[0]], totalCents: 1000 });
  const summary = buildSummary([...boundarySales.slice(0, 3), duplicate], products, false, new Date('2026-11-02T04:59:59.000Z'));
  assert.equal(summary.month, '2026-11');
  assert.equal(summary.todaySalesCents, 1500);
  assert.equal(summary.todaySalesCount, 2);
  assert.equal(summary.monthSalesCents, 1500);
  assert.equal(summary.monthSalesCount, 2);
  assert.deepEqual(summary.topProducts[0], { productId: 'bolsas', name: 'Bolsas PRUEBA', totalCents: 1500, quantityUnits: 600, salesCount: 2 });
  assert.equal(summary.week.at(-1)?.date, '2026-11-01');
  assert.equal(summary.week.at(-2)?.totalCents, 500);
  assert.equal(buildSummary(boundarySales, products, false, new Date('2026-11-01T04:59:59.000Z')).month, '2026-10');
});

test('low-stock alerts use physical presentation minima, preserve unknown breakdowns and group distinct active products', () => {
  const physical: Product = { ...baseProduct, minStockByPresentation: [{ presentationId: 'paq', minimum: 10 }], stock: { puesto: 1000, almacen: 400 }, stockByPresentation: { puesto: [{ presentationId: 'paq', quantity: 10 }], almacen: [{ presentationId: 'paq', quantity: 4 }] } };
  const summary = buildSummary([], [physical, ...products.slice(1)], true);
  assert.equal(summary.lowStockCount, 1);
  assert.equal(summary.lowStock.length, 1);
  assert.deepEqual(summary.lowStock[0].alerts.map(row => row.location), ['puesto', 'almacen']);
  assert.equal(summary.lowStock[0].productId, 'bolsas');
  assert.ok(summary.lowStock[0].alerts.every(row => row.presentationId === 'paq' && row.minimum === 10));
  assert.equal(buildSummary([], products, false).lowStock.length, 0);
  assert.equal(buildSummary([], [{ ...baseProduct, minStockUnits: 0, stock: { puesto: 0, almacen: null } }], false).lowStockCount, 0);
  assert.equal(buildSummary([], [{ ...physical, minStockByPresentation: [{ presentationId: 'paq', minimum: 0 }], stock: { puesto: 0, almacen: null }, stockByPresentation: { puesto: [], almacen: null } }], false).lowStockCount, 1);
  assert.equal(buildSummary([], [{ ...baseProduct, active: false, stock: { puesto: null, almacen: null }, presentations: [] }], false).pendingProductsCount, 0);
});

test('exports accept only real inclusive calendar dates, and sales filters preserve PRUEBA and cancellation information', () => {
  for (const value of ['2026-02-30', '2026-13-01', '0000-01-01', '2026-2-01', '2026-10-01T00:00:00Z']) assert.equal(salesExportSchema.safeParse({ from: value }).success, false);
  assert.equal(salesExportSchema.safeParse({ from: '2026-11-02', to: '2026-11-01' }).success, false);
  assert.equal(stockExportSchema.safeParse({ from: '2026-11-02', to: '2026-11-01' }).success, false);
  assert.equal(salesExportSchema.safeParse({ from: '2028-02-29' }).success, true);
  const filtered = filterSales(boundarySales, salesExportSchema.parse({ from: '2026-11-01', to: '2026-11-01', documentType: 'boleta', paymentMethod: 'efectivo', query: 'PR-00000' }));
  assert.deepEqual(filtered.map(sale => sale.number), ['PR-000003', 'PR-000002']);
  assert.ok(filtered.every(sale => sale.status === 'PRUEBA'));
  assert.equal(filtered[0].cancelled, true);
  const named = saleAt('2026-11-01T06:00:00Z', { customer: { id: 'cliente', documentType: 'DNI', document: '12345678', name: 'Cliente PRUEBA', address: '' } });
  assert.equal(filterSales([named], salesExportSchema.parse({ query: '12345678' })).length, 1);
  assert.equal(filterSales([named], salesExportSchema.parse({ query: 'cliente prueba' })).length, 1);
});

test('inventory filters distinguish pending, counted zero, configured low and inactive products', () => {
  const apply = (status: string, location = 'puesto', query = '') => filterInventory(products, inventoryExportSchema.parse({ status, location, query })).map(product => product.id);
  assert.deepEqual(apply('low'), []);
  assert.deepEqual(apply('low', 'almacen'), []);
  assert.deepEqual(apply('pending', 'almacen').sort(), ['bolsas', 'legado', 'vasos']);
  assert.deepEqual(apply('zero').sort(), ['legado', 'vasos']);
  assert.deepEqual(apply('inactive'), ['inactivo']);
  assert.deepEqual(apply('ready', 'puesto', 'ALFA'), []);
  assert.deepEqual(apply('all', 'puesto', 'P-002'), ['vasos']);
});

test('CSV protects text formula injection while retaining actual numeric amounts and signed stock deltas', () => {
  for (const malicious of ['=2+3', '+cmd', '-cmd', '@SUM(A1)', '  =HYPERLINK()', '\t=cmd', '\r=cmd', '\n=cmd']) assert.ok(csvCell(malicious).startsWith('"\''));
  assert.equal(csvCell(-200), '-200');
  assert.equal(csvCell(2.5), '2.5');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell('Texto "seguro"; prueba'), '"Texto ""seguro""; prueba"');
});

let app: FastifyInstance;
let adminCookie = '';
let cashierCookie = '';
const call = (url: string, cookie = adminCookie) => app.inject({ method: 'GET', url: `/api${url}`, headers: cookie ? { cookie } : {} });
before(async () => {
  app = await buildApp({ seed: products, lookup: { token: '' } });
  for (const role of ['admin', 'cajero'] as const) {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${role}@stockfix.local`, password: role === 'admin' ? 'AdminDemo2026!' : 'CajeroDemo2026!' } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    if (role === 'admin') adminCookie = cookie; else cashierCookie = cookie;
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/cash/open', headers: { cookie: adminCookie }, payload: { openingCents: 0 } })).statusCode, 200);
  const customer = await app.inject({ method: 'POST', url: '/api/customers', headers: { cookie: adminCookie }, payload: { documentType: 'RUC', document: '20999999990', name: '=2+3 Cliente PRUEBA', address: '' } });
  assert.equal(customer.statusCode, 200);
  const sale = await app.inject({ method: 'POST', url: '/api/sales', headers: { cookie: cashierCookie }, payload: { idempotencyKey: randomUUID(), documentType: 'factura', customerId: customer.json().id, paymentMethod: 'yape', paidCents: 500, items: [{ productId: 'bolsas', presentationId: 'paq', quantity: 2, location: 'puesto' }] } });
  assert.equal(sale.statusCode, 200, sale.body);
});
after(async () => { await app?.close(); });

test('every report requires administrator authentication and invalid filters return 400', async () => {
  for (const type of ['sales', 'stock', 'inventory']) {
    assert.equal((await call(`/reports/${type}/export?format=csv`, '')).statusCode, 401);
    assert.equal((await call(`/reports/${type}/export?format=xlsx`, cashierCookie)).statusCode, 403);
    assert.equal((await call(`/reports/${type}/export?format=pdf`)).statusCode, 400);
  }
  for (const query of ['from=2026-02-30', 'from=2026-11-02&to=2026-11-01', 'documentType=guia', 'paymentMethod=tarjeta']) assert.equal((await call(`/reports/sales/export?${query}`)).statusCode, 400);
  assert.equal((await call('/reports/stock/export?location=otro')).statusCode, 400);
  assert.equal((await call('/reports/inventory/export?status=otro')).statusCode, 400);
});

test('product minimum validation rejects invented, fractional and out-of-range values without changing legacy products', async () => {
  const payload = { name: baseProduct.name, brand: baseProduct.brand, category: baseProduct.category, barcode: null, active: true, presentations: baseProduct.presentations };
  for (const minStockUnits of [-1, 0.5, 1_000_001, '100']) {
    const result = await app.inject({ method: 'PATCH', url: '/api/products/bolsas', headers: { cookie: adminCookie }, payload: { ...payload, minStockUnits } });
    assert.equal(result.statusCode, 400);
  }
  const existing = await app.inject({ method: 'PATCH', url: '/api/products/bolsas', headers: { cookie: adminCookie }, payload });
  assert.equal(existing.statusCode, 200, existing.body);
  assert.equal(existing.json().minStockUnits, 1000);
  const summary = (await call('/summary')).json<Summary>();
  assert.equal(summary.month, limaDate(new Date()).slice(0, 7));
  assert.equal(summary.monthSalesCents, 500);
  assert.equal(summary.lowStockCount, 0);
});

test('real XLSX sales export has detail, numeric soles, text identifiers and truthful fiscal state; CSV respects filters', async () => {
  const date = limaDate(new Date());
  const response = await call(`/reports/sales/export?format=xlsx&from=${date}&to=${date}&documentType=factura&paymentMethod=yape&query=20999999990`);
  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers['content-type']), /spreadsheetml/);
  assert.match(String(response.headers['content-disposition']), /PRUEBA\.xlsx/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.rawPayload);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Ventas', 'Detalle']);
  const sales = workbook.getWorksheet('Ventas')!;
  assert.equal(sales.rowCount, 2);
  assert.equal(sales.getCell('D2').value, 'PRUEBA');
  assert.equal(sales.getCell('F2').value, '=2+3 Cliente PRUEBA');
  assert.equal(sales.getCell('H2').value, '20999999990');
  assert.equal(sales.getCell('J2').value, 5);
  assert.equal(sales.getCell('J2').type, ExcelJS.ValueType.Number);
  assert.equal(workbook.getWorksheet('Detalle')!.getCell('J2').value, 200);
  const csv = await call('/reports/sales/export?format=csv&documentType=factura&paymentMethod=yape');
  assert.equal(csv.rawPayload.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.match(csv.body, /"'=2\+3 Cliente PRUEBA"/);
  assert.match(csv.body, /PRUEBA/);
  assert.equal(csv.body.trim().split('\r\n').length, 2);
  assert.equal((await call('/reports/sales/export?format=csv&documentType=boleta')).body.trim().split('\r\n').length, 1);
});

test('inventory workbook leaves unknown counts, totals and minimums blank, retaining counted zero as a number', async () => {
  const response = await call('/reports/inventory/export?format=xlsx');
  assert.equal(response.statusCode, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.rawPayload);
  const inventory = workbook.getWorksheet('Inventario')!;
  const rows = inventory.getRows(2, inventory.rowCount - 1)!;
  const bags = rows.find(row => row.getCell(1).value === 'P-001')!;
  assert.equal(bags.getCell(7).value, 800);
  assert.equal(bags.getCell(9).value, null);
  assert.equal(bags.getCell(10).value, 'Por contar');
  assert.equal(bags.getCell(11).value, null);
  assert.equal(bags.getCell(12).value, null);
  assert.equal(bags.getCell(14).value, 'Por contar');
  assert.equal(bags.getCell(15).value, 'Por contar');
  const cups = rows.find(row => row.getCell(1).value === 'P-002')!;
  assert.equal(cups.getCell(7).value, 0);
  assert.equal(cups.getCell(11).value, 0);
  assert.equal(cups.getCell(12).value, null);
  assert.equal(workbook.getWorksheet('Presentaciones')!.getCell('E2').type, ExcelJS.ValueType.Number);
  const pending = await call('/reports/inventory/export?format=csv&location=almacen&status=low');
  assert.equal(pending.body.trim().split('\r\n').length, 1);
});

test('inventory CSV and XLSX export actual package counts instead of equivalences from total units', async () => {
  const physical: Product = { ...baseProduct, id: 'physical-bags', sku: 'P-FISICO', name: 'Bolsas físicas PRUEBA',
    stock: { puesto: 13000, almacen: null }, presentations: [
      { id: 'pack', label: 'Paquete de 100', units: 100, priceCents: 250 },
      { id: 'bundle', label: 'Fardo de 50 paquetes', units: 5000, priceCents: 10000 },
    ], stockByPresentation: { puesto: [{ presentationId: 'pack', quantity: 30 }, { presentationId: 'bundle', quantity: 2 }], almacen: null } };
  const source = [physical, { ...baseProduct, id: 'unrelated', sku: 'P-OTRO' }];
  const beforeExport = structuredClone(source);
  const fixture = Fastify();
  registerReports(fixture, { requireAdmin: async () => ({ id: 'admin', name: 'Admin', email: 'admin@example.invalid', role: 'admin', active: true }), loadSales: async () => [], loadProducts: async () => source, loadMovements: async () => [] });
  try {
    const response = await fixture.inject({ method: 'GET', url: '/api/reports/inventory/export?format=xlsx&query=P-FISICO&location=puesto' });
    assert.equal(response.statusCode, 200, response.body);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.rawPayload);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Inventario', 'Presentaciones', 'Existencias por presentación']);
    const summary = workbook.getWorksheet('Inventario')!;
    assert.equal(summary.rowCount, 2);
    assert.equal(summary.getCell('G2').value, 13000);
    assert.equal(summary.getCell('N1').value, 'Puesto por presentación');
    assert.equal(summary.getCell('O1').value, 'Almacén por presentación');
    assert.equal(summary.getCell('N2').value, '30 × Paquete de 100 | 2 × Fardo de 50 paquetes | 0 unidades sueltas');
    assert.equal(summary.getCell('O2').value, 'Por contar');
    const detail = workbook.getWorksheet('Existencias por presentación')!;
    assert.equal(detail.rowCount, 5);
    assert.equal(detail.getCell('A2').value, 'P-FISICO');
    assert.equal(detail.getCell('C2').value, 'Puesto');
    assert.equal(detail.getCell('D2').value, 'Paquete de 100');
    assert.equal(detail.getCell('E2').value, 100);
    assert.equal(detail.getCell('F2').value, 30);
    assert.equal(detail.getCell('G2').value, 3000);
    assert.equal(detail.getCell('F2').type, ExcelJS.ValueType.Number);
    assert.equal(detail.getCell('G2').type, ExcelJS.ValueType.Number);
    assert.equal(detail.getCell('D3').value, 'Fardo de 50 paquetes');
    assert.equal(detail.getCell('F3').value, 2);
    assert.equal(detail.getCell('G3').value, 10000);
    assert.equal(detail.getCell('D4').value, 'Unidades sueltas');
    assert.equal(detail.getCell('F4').value, 0);
    assert.equal(detail.getCell('G4').value, 0);
    assert.equal(detail.getCell('C5').value, 'Almacén');
    assert.equal(detail.getCell('E5').value, null);
    assert.equal(detail.getCell('F5').value, null);
    assert.equal(detail.getCell('G5').value, null);
    assert.equal(detail.getCell('H5').value, 'Por contar');
    const csv = await fixture.inject({ method: 'GET', url: '/api/reports/inventory/export?format=csv&query=P-FISICO&location=puesto' });
    assert.equal(csv.body.trim().split('\r\n').length, 2);
    assert.match(csv.body, /"Puesto por presentación";"Almacén por presentación"/);
    assert.match(csv.body, /"30 × Paquete de 100 \| 2 × Fardo de 50 paquetes \| 0 unidades sueltas";"Por contar"/);
    assert.deepEqual(source, beforeExport);
  } finally { await fixture.close(); }
});

test('package export keeps unknown legacy packaging blank and confirmed zero quantities numeric with shared filters', async () => {
  const legacy: Product = { ...baseProduct, id: 'legacy-bundles', sku: 'P-LEGADO', stock: { puesto: 5000, almacen: 0 }, stockByPresentation: undefined };
  const zero: Product = { ...baseProduct, id: 'zero-bundles', sku: 'P-CERO', stock: { puesto: 0, almacen: null }, stockByPresentation: { puesto: [], almacen: null } };
  const source = [legacy, zero];
  const beforeExport = structuredClone(source);
  const fixture = Fastify();
  registerReports(fixture, { requireAdmin: async () => ({ id: 'admin', name: 'Admin', email: 'admin@example.invalid', role: 'admin', active: true }), loadSales: async () => [], loadProducts: async () => source, loadMovements: async () => [] });
  try {
    const legacyExport = await fixture.inject({ method: 'GET', url: '/api/reports/inventory/export?format=xlsx&query=P-LEGADO' });
    const legacyBook = new ExcelJS.Workbook();
    await legacyBook.xlsx.load(legacyExport.rawPayload);
    const inventory = legacyBook.getWorksheet('Inventario')!;
    assert.equal(inventory.getCell('G2').value, 5000);
    assert.equal(inventory.getCell('I2').value, 0);
    assert.equal(inventory.getCell('N2').value, 'Por contar');
    assert.equal(inventory.getCell('O2').value, 'Por contar');
    const legacyCounts = legacyBook.getWorksheet('Existencias por presentación')!;
    assert.equal(legacyCounts.rowCount, 3);
    for (const rowNumber of [2, 3]) {
      assert.equal(legacyCounts.getCell(`E${rowNumber}`).value, null);
      assert.equal(legacyCounts.getCell(`F${rowNumber}`).value, null);
      assert.equal(legacyCounts.getCell(`G${rowNumber}`).value, null);
      assert.equal(legacyCounts.getCell(`H${rowNumber}`).value, 'Por contar');
    }
    const zeroExport = await fixture.inject({ method: 'GET', url: '/api/reports/inventory/export?format=xlsx&location=puesto&status=zero&query=P-CERO' });
    const zeroBook = new ExcelJS.Workbook();
    await zeroBook.xlsx.load(zeroExport.rawPayload);
    assert.equal(zeroBook.getWorksheet('Inventario')!.rowCount, 2);
    const zeroCounts = zeroBook.getWorksheet('Existencias por presentación')!;
    assert.equal(zeroCounts.getCell('F2').value, 0);
    assert.equal(zeroCounts.getCell('F2').type, ExcelJS.ValueType.Number);
    assert.equal(zeroCounts.getCell('G2').value, 0);
    assert.equal(zeroCounts.getCell('H2').value, 'Contado');
    const none = await fixture.inject({ method: 'GET', url: '/api/reports/inventory/export?format=xlsx&location=puesto&status=zero&query=P-LEGADO' });
    const emptyBook = new ExcelJS.Workbook();
    await emptyBook.xlsx.load(none.rawPayload);
    assert.equal(emptyBook.getWorksheet('Inventario')!.rowCount, 1);
    assert.equal(emptyBook.getWorksheet('Existencias por presentación')!.rowCount, 1);
    assert.deepEqual(source, beforeExport);
  } finally { await fixture.close(); }
});

test('movement export preserves all filtered rows beyond 100, negative quantities and inclusive Lima dates', async () => {
  const movements: StockMovement[] = Array.from({ length: 125 }, (_, index) => ({ id: `m-${index}`, productId: 'bolsas', productName: 'Bolsas PRUEBA', location: 'almacen', quantityUnits: -100, type: 'venta', reason: 'Cliente PRUEBA', userName: 'Cajero PRUEBA', createdAt: '2026-11-02T04:59:59.999Z' }));
  const filter = stockExportSchema.parse({ from: '2026-11-01', to: '2026-11-01', query: 'cliente prueba', location: 'almacen' });
  assert.equal(filterStockMovements(movements, filter).length, 125);
  // The inventory UI searches each field independently; joining fields would
  // export rows not visible when a query straddles the name and reason.
  assert.equal(filterStockMovements(movements, stockExportSchema.parse({ query: 'PRUEBA Cliente' })).length, 0);
  assert.equal(filterStockMovements(movements, stockExportSchema.parse({ query: 'Cajero PRUEBA' })).length, 125);
  assert.equal(filterStockMovements(movements, stockExportSchema.parse({ location: 'puesto' })).length, 0);
  const fixture = Fastify();
  registerReports(fixture, { requireAdmin: async () => ({ id: 'admin', name: 'Admin', email: 'admin@example.invalid', role: 'admin', active: true } satisfies User), loadSales: async () => [], loadProducts: async () => [], loadMovements: async () => movements });
  try {
    const response = await fixture.inject({ method: 'GET', url: '/api/reports/stock/export?format=xlsx&from=2026-11-01&to=2026-11-01&location=almacen&query=cliente' });
    assert.equal(response.statusCode, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.rawPayload);
    const sheet = workbook.getWorksheet('Movimientos')!;
    assert.equal(sheet.rowCount, 126);
    assert.equal(sheet.getCell('F2').value, -100);
    assert.equal(sheet.getCell('A2').value, '2026-11-01 23:59:59');
  } finally { await fixture.close(); }
});
