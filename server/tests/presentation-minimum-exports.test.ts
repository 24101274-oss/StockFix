import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import Fastify from 'fastify';
import type { Product } from '../../shared/types.js';
import { buildSummary, registerReports } from '../reports.js';

const physical: Product = {
  id: 'bags', sku: 'PR-001', name: 'Bolsas PRUEBA', brand: '', category: 'Bolsas', barcode: null, active: true,
  stock: { puesto: 13000, almacen: 5003 },
  presentations: [
    { id: 'package', label: 'Paquete de 100', units: 100, priceCents: 250 },
    { id: 'bundle', label: 'Fardo de 50 paquetes', units: 5000, priceCents: 10000 },
  ],
  stockByPresentation: {
    puesto: [{ presentationId: 'package', quantity: 30 }, { presentationId: 'bundle', quantity: 2 }],
    almacen: [{ presentationId: 'package', quantity: 0 }, { presentationId: 'bundle', quantity: 1 }, { presentationId: null, quantity: 3 }],
  },
  minStockUnits: 999999999,
  minStockByPresentation: [{ presentationId: 'package', minimum: 20 }, { presentationId: 'bundle', minimum: 3 }, { presentationId: null, minimum: 0 }],
  sourceNotes: [],
};

async function inventoryExport(products: Product[], query = 'format=xlsx') {
  const fixture = Fastify();
  registerReports(fixture, {
    requireAdmin: async () => ({ id: 'admin', name: 'Admin PRUEBA', email: 'admin@example.invalid', role: 'admin', active: true }),
    loadProducts: async () => products, loadSales: async () => [], loadMovements: async () => [],
  });
  try {
    const response = await fixture.inject({ method: 'GET', url: `/api/reports/inventory/export?${query}` });
    assert.equal(response.statusCode, 200, response.body);
    return response;
  } finally { await fixture.close(); }
}

async function workbookOf(products: Product[], query?: string) {
  const response = await inventoryExport(products, query);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.rawPayload);
  return workbook;
}

test('inventory XLSX exports configured physical minimums and per-location states without base-unit conversion', async () => {
  const source = [structuredClone(physical)];
  const original = structuredClone(source);
  const workbook = await workbookOf(source);
  const inventory = workbook.getWorksheet('Inventario')!;
  assert.equal(inventory.getCell('L1').value, 'Mínimos por presentación');
  assert.equal(inventory.getCell('L2').value, 'Paquete de 100: 20 | Fardo de 50 paquetes: 3 | Unidades sueltas: 0');
  assert.equal(inventory.getCell('G2').value, 13000);
  assert.equal(inventory.getCell('N2').value, '30 × Paquete de 100 | 2 × Fardo de 50 paquetes | 0 unidades sueltas');
  assert.equal(inventory.getCell('P2').value, '2 × Fardo de 50 paquetes (mínimo 3) | 0 × Unidades sueltas (mínimo 0)');
  assert.equal(inventory.getCell('Q2').value, '0 × Paquete de 100 (mínimo 20) | 1 × Fardo de 50 paquetes (mínimo 3)');
  assert.ok(!JSON.stringify(inventory.getRow(2).values).includes('999999999'));

  const detail = workbook.getWorksheet('Existencias por presentación')!;
  assert.equal(detail.getCell('I1').value, 'Mínimo (presentaciones)');
  assert.equal(detail.getCell('J1').value, 'Estado de stock');
  const rows = detail.getRows(2, detail.rowCount - 1)!;
  const find = (location: string, label: string) => rows.find(row => row.getCell(3).value === location && row.getCell(4).value === label)!;
  const packageAtStall = find('Puesto', 'Paquete de 100');
  assert.equal(packageAtStall.getCell(6).value, 30);
  assert.equal(packageAtStall.getCell(7).value, 3000);
  assert.equal(packageAtStall.getCell(9).value, 20);
  assert.equal(packageAtStall.getCell(9).type, ExcelJS.ValueType.Number);
  assert.equal(packageAtStall.getCell(10).value, 'Disponible');
  const bundlesAtStall = find('Puesto', 'Fardo de 50 paquetes');
  assert.equal(bundlesAtStall.getCell(6).value, 2);
  assert.equal(bundlesAtStall.getCell(7).value, 10000);
  assert.equal(bundlesAtStall.getCell(9).value, 3);
  assert.equal(bundlesAtStall.getCell(10).value, 'Stock bajo');
  assert.equal(find('Puesto', 'Unidades sueltas').getCell(9).value, 0);
  assert.equal(find('Puesto', 'Unidades sueltas').getCell(10).value, 'Stock bajo');
  assert.equal(find('Almacén', 'Unidades sueltas').getCell(10).value, 'Disponible');

  const presentations = workbook.getWorksheet('Presentaciones')!;
  assert.equal(presentations.getCell('F1').value, 'Mínimo (presentaciones)');
  assert.equal(presentations.getCell('F2').value, 20);
  assert.equal(presentations.getCell('F3').value, 3);
  assert.equal(presentations.getCell('C4').value, 'Unidades sueltas (stock)');
  assert.equal(presentations.getCell('E4').value, null);
  assert.equal(presentations.getCell('F4').value, 0);
  assert.deepEqual(source, original);
});

test('CSV publishes physical minimum and alert summaries and grouped summary counts each product once', async () => {
  const source = [structuredClone(physical)];
  const before = structuredClone(source);
  const response = await inventoryExport(source, 'format=csv');
  assert.match(response.body, /"Mínimos por presentación"/);
  assert.doesNotMatch(response.body, /"Mínimo por ubicación"/);
  assert.doesNotMatch(response.body, /999999999/);
  assert.match(response.body, /"Paquete de 100: 20 \| Fardo de 50 paquetes: 3 \| Unidades sueltas: 0"/);
  assert.match(response.body, /"2 × Fardo de 50 paquetes \(mínimo 3\) \| 0 × Unidades sueltas \(mínimo 0\)"/);
  const summary = buildSummary([], source, false);
  assert.equal(summary.lowStockCount, 1);
  assert.equal(summary.lowStock.length, 1);
  assert.equal(summary.lowStock[0].productId, physical.id);
  assert.equal(summary.lowStock[0].alerts.length, 4);
  assert.ok(!summary.lowStock[0].alerts.some(alert => alert.location === 'puesto' && alert.presentationId === 'package'));
  assert.deepEqual(source, before);
});

test('unknown packaging and legacy total minimums remain blank rather than becoming physical alerts', async () => {
  const legacy: Product = { ...structuredClone(physical), stockByPresentation: undefined, minStockByPresentation: undefined };
  const workbook = await workbookOf([legacy]);
  const inventory = workbook.getWorksheet('Inventario')!;
  assert.equal(inventory.getCell('G2').value, 13000);
  assert.equal(inventory.getCell('L2').value, null);
  assert.equal(inventory.getCell('P2').value, 'Por contar');
  assert.equal(inventory.getCell('Q2').value, 'Por contar');
  const detail = workbook.getWorksheet('Existencias por presentación')!;
  for (const row of detail.getRows(2, detail.rowCount - 1)!) {
    assert.equal(row.getCell(6).value, null);
    assert.equal(row.getCell(9).value, null);
    assert.equal(row.getCell(10).value, 'Por contar');
  }
  assert.equal(workbook.getWorksheet('Presentaciones')!.getCell('F2').value, null);
  assert.equal(buildSummary([], [legacy], false).lowStockCount, 0);

  const unknown: Product = { ...structuredClone(physical), stock: { puesto: null, almacen: null }, stockByPresentation: { puesto: null, almacen: null } };
  const unknownBook = await workbookOf([unknown]);
  assert.equal(unknownBook.getWorksheet('Inventario')!.getCell('G2').value, null);
  assert.equal(unknownBook.getWorksheet('Existencias por presentación')!.getCell('I2').value, null);
  assert.equal(buildSummary([], [unknown], false).lowStockCount, 0);
});

test('zero with no configured physical minimum does not invent an alert from the legacy setting', async () => {
  const zero: Product = { ...structuredClone(physical), stock: { puesto: 0, almacen: 0 }, stockByPresentation: { puesto: [], almacen: [] }, minStockUnits: 0, minStockByPresentation: undefined };
  const workbook = await workbookOf([zero]);
  const inventory = workbook.getWorksheet('Inventario')!;
  assert.equal(inventory.getCell('L2').value, null);
  assert.equal(inventory.getCell('P2').value, 'Sin alertas');
  const detail = workbook.getWorksheet('Existencias por presentación')!;
  assert.equal(detail.getCell('F2').value, 0);
  assert.equal(detail.getCell('I2').value, null);
  assert.equal(detail.getCell('J2').value, 'Sin mínimo');
  assert.equal(buildSummary([], [zero], false).lowStockCount, 0);
});

test('low-stock export filters include only active confirmed physical alerts and preserve source data', async () => {
  const source = [structuredClone(physical),
    { ...structuredClone(physical), id: 'inactive', sku: 'PR-002', active: false },
    { ...structuredClone(physical), id: 'legacy', sku: 'PR-003', stockByPresentation: undefined },
  ];
  const before = structuredClone(source);
  const workbook = await workbookOf(source, 'format=xlsx&status=low&location=puesto');
  const inventory = workbook.getWorksheet('Inventario')!;
  assert.equal(inventory.rowCount, 2);
  assert.equal(inventory.getCell('A2').value, 'PR-001');
  const csv = await inventoryExport(source, 'format=csv&status=low&location=almacen&query=PR-001');
  assert.equal(csv.body.trim().split('\r\n').length, 2);
  const none = await workbookOf(source, 'format=xlsx&status=low&location=puesto&query=PR-003');
  assert.equal(none.getWorksheet('Inventario')!.rowCount, 1);
  assert.equal(none.getWorksheet('Existencias por presentación')!.rowCount, 1);
  const inactiveBook = await workbookOf(source, 'format=xlsx&query=PR-002');
  assert.equal(inactiveBook.getWorksheet('Inventario')!.getCell('P2').value, 'Inactivo');
  assert.equal(inactiveBook.getWorksheet('Existencias por presentación')!.getCell('J2').value, 'Inactivo');
  assert.deepEqual(source, before);
});
