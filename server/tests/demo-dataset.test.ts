import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { generateSyntheticDataset, syntheticOperationalHash } from '../demo/dataset.js';
import { SYNTHETIC_DATA_LABEL, type SyntheticDataset } from '../../shared/demo-dataset.js';
import { countStockUnits } from '../../shared/stock-packaging.js';
import { productSchema, purchaseSchema, saleSchema, supplierSchema } from '../validation.js';
import type { LocationId } from '../../shared/types.js';

const options = { seed: 'stockfix-dds-10', asOfDate: '2026-11-26', months: 36 };
const dataset = generateSyntheticDataset(options);
const limaCalendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' });
const limaDate = (instant: string) => limaCalendar.format(new Date(instant));
const monthUnits = (data: SyntheticDataset, productId: string, month: string) => data.sales
  .filter(operation => limaDate(operation.data.createdAt).startsWith(month))
  .flatMap(operation => operation.data.items)
  .filter(item => item.productId === productId)
  .reduce((total, item) => total + item.units, 0);

test('DDS-10: fixed options reproduce complete operational content and hashes', () => {
  assert.deepEqual(generateSyntheticDataset(options), dataset);
  assert.equal(dataset.manifest.dataSha256, syntheticOperationalHash(dataset));
  assert.notEqual(generateSyntheticDataset({ ...options, seed: 'otra-semilla' }).manifest.dataSha256, dataset.manifest.dataSha256);
  const changed = structuredClone(dataset);
  changed.products[0].stock.puesto!++;
  assert.notEqual(syntheticOperationalHash(changed), dataset.manifest.dataSha256);
  assert.match(dataset.manifest.id, /^synthetic-v1-[a-f0-9]{24}$/);
  for (const changedOptions of [{ ...options, seed: 'otra-semilla' }, { ...options, asOfDate: '2026-11-25' }, { ...options, months: 24 }]) {
    assert.notEqual(generateSyntheticDataset(changedOptions).manifest.id, dataset.manifest.id);
  }
  assert.deepEqual(dataset.manifest.counts, { products: 6, sales: dataset.sales.length, purchases: dataset.purchases.length,
    stockMovements: dataset.stockMovements.length, cashSessions: dataset.cashSessions.length });
  for (const rows of [dataset.products, dataset.suppliers, dataset.stockMovements, dataset.cashSessions, dataset.sales.map(row => row.data), dataset.purchases.map(row => row.data)]) {
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  }
});

test('DDS-10: reject invalid calendar dates, empty seeds and unbounded histories', () => {
  for (const asOfDate of ['2026-02-29', '2025-04-31', '2026-00-20', '2026-13-01', '2026-11-00', '2026-11-31', '2026-1-03', '0000-01-01', 'ayer']) {
    assert.throws(() => generateSyntheticDataset({ ...options, asOfDate }), Error, asOfDate);
  }
  for (const months of [0, 11, 61, 12.5, Infinity, NaN]) assert.throws(() => generateSyntheticDataset({ ...options, months }));
  assert.throws(() => generateSyntheticDataset({ ...options, seed: '  ' }));
  assert.throws(() => generateSyntheticDataset({ ...options, asOfDate: '0001-01-01' }));
  assert.equal(generateSyntheticDataset({ ...options, asOfDate: '2024-02-29', months: 12 }).manifest.observedThrough, '2024-02-29');
  assert.equal(generateSyntheticDataset({ ...options, months: 60 }).manifest.completeMonths, 60);
});

test('DDS-10: Lima year boundary includes twelve complete months and the current partial month', () => {
  const boundary = generateSyntheticDataset({ ...options, asOfDate: '2026-01-03', months: 12 });
  assert.equal(boundary.manifest.historyStart, '2025-01-01');
  assert.equal(boundary.manifest.lastCompleteMonth, '2025-12');
  assert.ok(boundary.sales.some(operation => limaDate(operation.data.createdAt) === '2026-01-03'));
  const noSaleDays = generateSyntheticDataset({ ...options, asOfDate: '2026-01-02', months: 12 });
  assert.ok(noSaleDays.sales.every(operation => limaDate(operation.data.createdAt) < '2026-01-01'));
  assert.equal(noSaleDays.manifest.observedThrough, '2026-01-02');
});

test('DDS-10: observed zero months and unknown pre-introduction months are distinct', () => {
  const intermittent = dataset.manifest.coverage.find(coverage => coverage.pattern.startsWith('intermitente'))!;
  const knownMonths = Array.from({ length: 12 }, (_, index) => `2025-${String(index + 1).padStart(2, '0')}`);
  assert.ok(knownMonths.some(month => monthUnits(dataset, intermittent.productId, month) === 0));
  assert.ok(knownMonths.some(month => monthUnits(dataset, intermittent.productId, month) > 0));
  assert.equal(intermittent.observedFrom, dataset.manifest.historyStart);
  const introduced = dataset.manifest.coverage.find(coverage => coverage.pattern === 'producto nuevo')!;
  assert.equal(introduced.introducedOn, '2026-08-01');
  assert.equal(introduced.observedFrom, introduced.introducedOn);
  assert.ok(dataset.sales.flatMap(operation => operation.data.items.map(item => ({ item, createdAt: operation.data.createdAt })))
    .filter(({ item }) => item.productId === introduced.productId)
    .every(({ createdAt }) => limaDate(createdAt) >= introduced.introducedOn));
  assert.ok(dataset.stockMovements.filter(movement => movement.productId === introduced.productId).every(movement => limaDate(movement.createdAt) >= introduced.introducedOn));
  assert.ok(monthUnits(dataset, introduced.productId, '2026-08') > 0);
  const trending = dataset.manifest.coverage.find(coverage => coverage.pattern === 'tendencia creciente')!;
  assert.ok(monthUnits(dataset, trending.productId, '2026-01') > monthUnits(dataset, trending.productId, '2024-01'));
  const seasonal = dataset.manifest.coverage.find(coverage => coverage.pattern === 'estacionalidad anual')!;
  assert.ok(monthUnits(dataset, seasonal.productId, '2025-12') > monthUnits(dataset, seasonal.productId, '2025-02'));
});

test('DDS-10: every operation stays within coverage and no operation follows the cutoff date', () => {
  const dates = [...dataset.sales.map(row => row.data.createdAt), ...dataset.purchases.map(row => row.data.createdAt),
    ...dataset.stockMovements.map(row => row.createdAt), ...dataset.cashSessions.flatMap(row => [row.openedAt, row.closedAt!])];
  for (const instant of dates) {
    assert.ok(limaDate(instant) >= dataset.manifest.historyStart, instant);
    assert.ok(limaDate(instant) <= options.asOfDate, instant);
  }
  for (const operation of dataset.sales) assert.ok([3, 9, 15, 21, 27].includes(Number(limaDate(operation.data.createdAt).slice(-2))));
  for (const operation of dataset.purchases) assert.equal(limaDate(operation.data.createdAt).slice(-2), '01');
  const early = generateSyntheticDataset({ ...options, asOfDate: '2026-11-09' });
  assert.ok(monthUnits(early, early.products[0].id, '2026-11') < monthUnits(dataset, dataset.products[0].id, '2026-11'));
  assert.ok(early.sales.every(row => limaDate(row.data.createdAt) <= '2026-11-09'));
});

test('DDS-10: quantities, physical units and prices agree with catalog presentations', () => {
  const allPresentationIds = dataset.products.flatMap(product => product.presentations.map(presentation => presentation.id));
  assert.equal(new Set(allPresentationIds).size, allPresentationIds.length);
  for (const product of dataset.products) {
    const { name, brand, category, barcode, active, presentations, minStockUnits, minStockByPresentation } = product;
    assert.equal(productSchema.safeParse({ name, brand, category, barcode, active, presentations, minStockUnits, minStockByPresentation }).success, true);
    assert.ok(product.sourceNotes.includes(SYNTHETIC_DATA_LABEL));
  }
  assert.equal(supplierSchema.safeParse({ ruc: dataset.suppliers[0].ruc, name: dataset.suppliers[0].name, address: dataset.suppliers[0].address, phone: '' }).success, true);
  for (const operation of dataset.sales) {
    const sale = operation.data;
    const input = { idempotencyKey: operation.idempotencyKey, documentType: sale.documentType, customerId: null, paymentMethod: sale.paymentMethod, paidCents: sale.paidCents,
      items: sale.items.map(({ productId, presentationId, quantity, location }) => ({ productId, presentationId, quantity, location })) };
    assert.equal(saleSchema.safeParse(input).success, true);
    assert.equal(operation.requestHash, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
    assert.equal(sale.userName, SYNTHETIC_DATA_LABEL);
    assert.equal(sale.status, 'PRUEBA');
    for (const item of sale.items) {
      const product = dataset.products.find(product => product.id === item.productId)!;
      const presentation = product.presentations.find(presentation => presentation.id === item.presentationId)!;
      assert.equal(item.units, item.quantity * presentation.units);
      assert.equal(item.totalCents, item.quantity * presentation.priceCents);
      assert.ok(Number.isInteger(item.quantity) && item.quantity > 0);
    }
    assert.equal(sale.totalCents, sale.items.reduce((total, item) => total + item.totalCents, 0));
    assert.equal(sale.changeCents, sale.paidCents - sale.totalCents);
  }
  for (const operation of dataset.purchases) {
    const { idempotencyKey, supplierId, document, location, paymentMethod, paidFromCash, totalPaidCents, items } = operation.data;
    assert.equal(purchaseSchema.safeParse({ idempotencyKey, supplierId, document, location, paymentMethod, paidFromCash, totalPaidCents, items }).success, true);
    assert.equal(operation.requestHash, createHash('sha256').update(JSON.stringify({ idempotencyKey, supplierId, document, location, paymentMethod, paidFromCash, totalPaidCents, items })).digest('hex'));
    assert.equal(paymentMethod, 'transferencia');
    assert.equal(paidFromCash, false);
    assert.equal(totalPaidCents, items.reduce((total, item) => total + item.quantity * item.unitCostCents!, 0));
  }
});

test('DDS-10: inventory ledger, physical package counts and operations reconcile exactly', () => {
  const balances = new Map<string, number>();
  for (const movement of dataset.stockMovements) {
    const key = `${movement.productId}/${movement.location}`;
    const balance = (balances.get(key) ?? 0) + movement.quantityUnits;
    assert.ok(balance >= 0, key);
    balances.set(key, balance);
    if (movement.type === 'compra') {
      const purchase = dataset.purchases.find(operation => operation.data.number === movement.reason)!.data;
      const product = dataset.products.find(product => product.id === movement.productId)!;
      const units = purchase.items.filter(item => item.productId === product.id)
        .map(item => item.quantity * product.presentations.find(presentation => presentation.id === item.presentationId)!.units);
      assert.ok(units.includes(movement.quantityUnits));
    } else {
      const sale = dataset.sales.find(operation => operation.data.number === movement.reason)!.data;
      assert.ok(sale.items.some(item => item.productId === movement.productId && item.units === -movement.quantityUnits && item.location === movement.location));
    }
  }
  for (const product of dataset.products) {
    for (const location of ['puesto', 'almacen'] as LocationId[]) {
      const counts = product.stockByPresentation![location]!;
      assert.equal(countStockUnits(product.presentations, counts), product.stock[location]);
      assert.equal(balances.get(`${product.id}/${location}`), product.stock[location]);
      assert.ok(counts.every(count => count.presentationId === null || product.presentations.find(item => item.id === count.presentationId)!.units > 1));
      assert.deepEqual(counts.map(count => count.quantity), [2, 5]);
    }
  }
});

test('DDS-10: one closed cash session per sales day reconciles all payment methods', () => {
  const salesDays = new Set(dataset.sales.map(operation => limaDate(operation.data.createdAt)));
  assert.equal(dataset.cashSessions.length, salesDays.size);
  assert.equal(new Set(dataset.cashSessions.map(cash => limaDate(cash.openedAt))).size, salesDays.size);
  for (const cash of dataset.cashSessions) {
    const date = limaDate(cash.openedAt);
    const sales = dataset.sales.filter(operation => limaDate(operation.data.createdAt) === date);
    const payments = { efectivo: 0, yape: 0, plin: 0, transferencia: 0 };
    for (const sale of sales) payments[sale.data.paymentMethod] += sale.data.totalCents;
    assert.deepEqual(cash.payments, payments);
    assert.equal(cash.openingCents, 10000);
    assert.equal(cash.expectedCents, 10000 + payments.efectivo);
    assert.equal(cash.countedCents, cash.expectedCents);
    assert.equal(cash.differenceCents, 0);
    assert.ok(cash.closedAt! > cash.openedAt);
    assert.deepEqual(cash.movements, []);
  }
});
