import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReplenishment } from '../replenishment/engine.js';
import type { ForecastReport, ForecastSeries } from '../../shared/forecast.js';
import type { ReplenishmentInput, ScenarioReceipt } from '../../shared/replenishment.js';
import type { LocationId, Product } from '../../shared/types.js';

function monthAt(value: number): string {
  return `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, '0')}`;
}

function product(puesto = 8, almacen = 0): Product {
  return { id: 'product', sku: 'DEMO-1', name: 'Producto DEMO', brand: 'DEMO', category: 'Prueba', barcode: null, active: true,
    presentations: [{ id: 'pack', label: 'Paquete de 100', units: 100, priceCents: 500 }], sourceNotes: [],
    stock: { puesto: puesto * 100, almacen: almacen * 100 },
    stockByPresentation: { puesto: [{ presentationId: 'pack', quantity: puesto }, { presentationId: null, quantity: 0 }],
      almacen: [{ presentationId: 'pack', quantity: almacen }, { presentationId: null, quantity: 0 }] } };
}

function report(location: LocationId, products: Product[], values: Record<string, number[]>, asOfDate: string, horizon: number): ForecastReport {
  const start = Number(asOfDate.slice(0, 4)) * 12 + Number(asOfDate.slice(5, 7)) - 1;
  const series: ForecastSeries[] = products.flatMap(product => product.presentations.map(presentation => ({
    id: `${product.id}/${presentation.id}/${location}`, productId: product.id, productName: product.name, sku: product.sku,
    presentationId: presentation.id, presentationLabel: presentation.label, unitsPerPresentation: presentation.units,
    status: 'ready', method: 'last-month', history: [], partial: null, evaluation: null, warnings: [],
    forecast: Array.from({ length: horizon }, (_, index) => ({ month: monthAt(start + index + 1),
      physicalUnits: values[presentation.id]?.[index] ?? 0,
      presentationQuantity: Math.ceil((values[presentation.id]?.[index] ?? 0) / presentation.units) })),
  })));
  return { version: 1, query: { cutoff: asOfDate, horizon, location }, timeZone: 'America/Lima', unit: 'physical-items',
    source: { kind: 'recorded', label: 'Ventas de prueba', datasetId: null, observedThrough: null },
    methodology: 'Prueba', warnings: ['Advertencia repetida'], series };
}

function fixture(demand = [20, 20, 20], warehouseDemand = demand.map(() => 0), puesto = 8, almacen = 0, asOfDate = '2026-11-26'): ReplenishmentInput {
  const products = [product(puesto, almacen)];
  return { asOfDate, products,
    forecasts: { puesto: report('puesto', products, { pack: demand.map(value => value * 100) }, asOfDate, demand.length),
      almacen: report('almacen', products, { pack: warehouseDemand.map(value => value * 100) }, asOfDate, demand.length) },
    scenario: { horizon: demand.length, leadTimeDays: 0, reservePercent: 10, receipts: [], bridgeDemand: [] } };
}

function receipt(id: string, expectedOn: string, quantity: number, changes: Partial<ScenarioReceipt> = {}): ScenarioReceipt {
  return { id, productId: 'product', presentationId: 'pack', location: 'puesto', quantity, expectedOn, status: 'pending', ...changes };
}

function looseFixture(): ReplenishmentInput {
  const input = fixture([0]);
  input.products[0].presentations.push({ id: 'unit-a', label: 'Unidad A', units: 1, priceCents: 10 }, { id: 'unit-b', label: 'Unidad B', units: 1, priceCents: 15 });
  input.products[0].stock.puesto = 807;
  input.products[0].stockByPresentation!.puesto!.find(row => row.presentationId === null)!.quantity = 7;
  input.forecasts = { puesto: report('puesto', input.products, { 'unit-a': [4], 'unit-b': [6] }, input.asOfDate, 1),
    almacen: report('almacen', input.products, {}, input.asOfDate, 1) };
  return input;
}

test('DDS-12: twenty packs with eight on hand and ten percent reserve suggest fourteen purchases', () => {
  const input = fixture();
  const plan = buildReplenishment(input);
  const first = plan.items[0].months[0];
  assert.equal(plan.firstMonth, '2026-12');
  assert.equal(first.demandPhysicalUnits.puesto, 2000);
  assert.equal(first.demand.puesto, 20);
  assert.equal(first.reserve.puesto, 2);
  assert.equal(first.suggestedPurchase.puesto, 14);
  assert.equal(first.uncoveredDemand.puesto, 12);
  assert.equal(first.closingWithoutThisPurchase.puesto, 0);
  assert.equal(first.closingIfRecommendations.puesto, 2);
  assert.equal(plan.items[0].months[1].opening.puesto, 2);
  assert.equal(plan.items[0].months[1].suggestedPurchase.puesto, 20);
  assert.equal(plan.items[0].months[2].closingIfRecommendations.puesto, 2);
  assert.deepEqual(plan.warnings, ['Advertencia repetida']);
});

test('DDS-12: warehouse transfers protect its own demand and reserve before supplying the stall', () => {
  const input = fixture([20], [5], 8, 20);
  const month = buildReplenishment(input).items[0].months[0];
  assert.equal(month.transferFromWarehouse, 14);
  assert.deepEqual(month.suggestedPurchase, { puesto: 0, almacen: 0 });
  assert.deepEqual(month.closingIfRecommendations, { puesto: 2, almacen: 1 });
  const warehouseShortage = buildReplenishment(fixture([20], [5], 8, 5)).items[0].months[0];
  assert.equal(warehouseShortage.transferFromWarehouse, 0);
  assert.deepEqual(warehouseShortage.suggestedPurchase, { puesto: 14, almacen: 1 });
  for (const row of [month, warehouseShortage]) {
    assert.equal(row.available.puesto, row.opening.puesto + row.receipts.puesto);
    assert.equal(row.available.almacen, row.opening.almacen + row.receipts.almacen);
    assert.equal(row.closingIfRecommendations.puesto, row.available.puesto + row.transferFromWarehouse + row.suggestedPurchase.puesto - row.demand.puesto);
    assert.equal(row.closingIfRecommendations.almacen, row.available.almacen - row.transferFromWarehouse + row.suggestedPurchase.almacen - row.demand.almacen);
  }
});

test('DDS-12: either unknown or inconsistent packaging balance blocks the whole physical bin', () => {
  const input = fixture([20]);
  input.products[0].stock.almacen = null;
  input.products[0].stockByPresentation!.almacen = null;
  let item = buildReplenishment(input).items[0];
  assert.equal(item.status, 'unknown-stock');
  assert.equal(item.initialStock.almacen, null);
  assert.deepEqual(item.months, []);
  input.products[0] = product();
  input.products[0].stock.puesto = 900;
  item = buildReplenishment(input).items[0];
  assert.equal(item.status, 'unknown-stock');
  assert.deepEqual(item.months, []);
});

test('DDS-12: multiple unit presentation IDs consume one loose pool and never reuse closed packs', () => {
  const input = looseFixture();
  input.scenario.bridgeDemand = [{ productId: 'product', presentationId: 'unit-a', location: 'puesto', quantity: 2 }];
  const plan = buildReplenishment(input);
  assert.equal(plan.items.length, 2);
  const loose = plan.items.find(item => item.presentationId === null)!;
  assert.deepEqual(loose.sourcePresentationIds, ['unit-a', 'unit-b']);
  assert.equal(loose.initialStock.puesto, 7);
  assert.equal(loose.afterBridge.puesto, 5);
  assert.equal(loose.months[0].demandPhysicalUnits.puesto, 10);
  assert.equal(loose.months[0].demand.puesto, 10);
  assert.equal(loose.months[0].suggestedPurchase.puesto, 6);
  const pack = plan.items.find(item => item.presentationId === 'pack')!;
  assert.equal(pack.initialStock.puesto, 8);
  assert.equal(pack.months[0].closingIfRecommendations.puesto, 8);
  input.scenario.receipts = [receipt('loose-pending', '2026-12-01', 3, { presentationId: 'unit-b' })];
  assert.equal(buildReplenishment(input).items.find(item => item.presentationId === null)!.months[0].receipts.puesto, 3);
});

test('DDS-12: explicit bridge shortages stay separate from nonnegative stock carried into the horizon', () => {
  const input = fixture([20]);
  input.scenario.bridgeDemand = [{ productId: 'product', presentationId: 'pack', location: 'puesto', quantity: 50 }];
  const item = buildReplenishment(input).items[0];
  assert.equal(item.bridgeUncovered.puesto, 42);
  assert.equal(item.afterBridge.puesto, 0);
  assert.equal(item.months[0].opening.puesto, 0);
  assert.equal(item.months[0].suggestedPurchase.puesto, 22);
  assert.ok(item.warnings.some(warning => warning.includes('no se arrastra')));
});

test('DDS-12: only future pending receipts enter once, with late receipts deferred to the next need date', () => {
  const input = fixture([20, 20, 20], [0, 0, 0], 0);
  input.scenario.reservePercent = 0;
  input.scenario.productId = 'product';
  input.products.push({ ...product(), id: 'other' });
  input.scenario.receipts = [
    receipt('before-horizon', '2026-11-27', 3), receipt('on-time', '2026-12-01', 5), receipt('late', '2026-12-15', 4),
    receipt('received', '2026-12-01', 200, { status: 'received' }), receipt('cancelled', '2026-12-01', 200, { status: 'cancelled' }),
    receipt('overdue', '2026-11-26', 200), receipt('outside', '2027-02-02', 200), receipt('other-product', '2026-12-01', 200, { productId: 'other' }),
  ];
  const plan = buildReplenishment(input);
  assert.deepEqual(plan.items[0].months.map(month => month.receipts.puesto), [8, 4, 0]);
  assert.deepEqual(plan.items[0].months.map(month => month.suggestedPurchase.puesto), [12, 16, 20]);
  assert.deepEqual(plan.receiptDispositions.map(row => row.status), ['scheduled', 'scheduled', 'scheduled', 'received-excluded', 'cancelled-excluded', 'overdue-excluded', 'outside-horizon', 'outside-filter']);
  assert.equal(plan.receiptDispositions.find(row => row.id === 'late')!.eligibleMonth, '2027-01');
  assert.ok(plan.items[0].warnings.some(warning => warning.includes('Llega después del día 1')));
});

test('DDS-12: missing, duplicate or insufficient source series never fabricate purchases', () => {
  const input = fixture([20]);
  const original = structuredClone(input.forecasts.almacen.series);
  input.forecasts.almacen.series = [];
  assert.equal(buildReplenishment(input).items[0].status, 'insufficient-history');
  input.forecasts.almacen.series = [...original, ...original];
  assert.equal(buildReplenishment(input).items[0].status, 'insufficient-history');
  input.forecasts.almacen.series = original;
  input.forecasts.almacen.series[0].status = 'insufficient-history';
  const item = buildReplenishment(input).items[0];
  assert.equal(item.status, 'insufficient-history');
  assert.deepEqual(item.months, []);
  const loose = looseFixture();
  loose.forecasts.puesto.series.find(row => row.presentationId === 'unit-b')!.forecast = [];
  assert.equal(buildReplenishment(loose).items.find(row => row.presentationId === null)!.status, 'insufficient-history');
});

test('DDS-12: lead times use actual leap and year calendar days and identify late recommendations', () => {
  const input = fixture([20], [0], 0, 0, '2024-02-28');
  input.scenario.leadTimeDays = 2;
  let month = buildReplenishment(input).items[0].months[0];
  assert.equal(month.needBy, '2024-03-01');
  assert.equal(month.orderBy, '2024-02-28');
  assert.equal(month.earliestArrivalIfOrderedToday, '2024-03-01');
  assert.equal(month.timingRisk, false);
  input.asOfDate = '2024-02-29';
  for (const location of ['puesto', 'almacen'] as const) input.forecasts[location].query.cutoff = input.asOfDate;
  month = buildReplenishment(input).items[0].months[0];
  assert.equal(month.earliestArrivalIfOrderedToday, '2024-03-02');
  assert.equal(month.timingRisk, true);
  assert.ok(month.warnings.length);
  const year = fixture([20], [0], 0, 0, '2026-12-31');
  year.scenario.leadTimeDays = 1;
  month = buildReplenishment(year).items[0].months[0];
  assert.equal(month.needBy, '2027-01-01');
  assert.equal(month.orderBy, '2026-12-31');
  assert.equal(month.earliestArrivalIfOrderedToday, '2027-01-01');
});

test('DDS-12: invalid and duplicate canonical scenario inputs are rejected before planning', () => {
  const input = looseFixture();
  input.scenario.bridgeDemand = [
    { productId: 'product', presentationId: null, location: 'puesto', quantity: 0 },
    { productId: 'product', presentationId: 'unit-b', location: 'puesto', quantity: 1 },
  ];
  assert.throws(() => buildReplenishment(input), /No repitas/);
  input.scenario.bridgeDemand = [];
  input.scenario.receipts = [receipt('same', '2026-12-01', 1), receipt('same', '2026-12-01', 2)];
  assert.throws(() => buildReplenishment(input), /identificador único/);
  input.scenario.receipts = [receipt('invalid-date', '2027-02-29', 1)];
  assert.throws(() => buildReplenishment(input), /fecha o el estado/);
  input.scenario.receipts = [receipt('invalid-ref', '2026-12-01', 1, { presentationId: 'missing' })];
  assert.throws(() => buildReplenishment(input), /presentación del escenario/);
  input.scenario.receipts = [];
  input.forecasts.puesto.query.cutoff = '2026-11-25';
  assert.throws(() => buildReplenishment(input), /corte actual/);
  const invalid = fixture([20]);
  for (const reservePercent of [-1, 101, NaN, 1.005]) assert.throws(() => buildReplenishment({ ...invalid, scenario: { ...invalid.scenario, reservePercent } }), /reserva/);
  for (const leadTimeDays of [-1, 366, 1.5]) assert.throws(() => buildReplenishment({ ...invalid, scenario: { ...invalid.scenario, leadTimeDays } }), /plazo/);
});

test('DDS-12: unsafe forecast, receipt aggregation and reserve targets block the affected bin', () => {
  const input = fixture([20]);
  for (const physicalUnits of [NaN, -1, 0.5, 1_000_000_001]) {
    input.forecasts.puesto.series[0].forecast[0].physicalUnits = physicalUnits;
    const item = buildReplenishment(input).items[0];
    assert.equal(item.status, 'quantity-limit');
    assert.deepEqual(item.months, []);
  }
  const receipts = fixture([20]);
  receipts.scenario.receipts = [receipt('very-large', '2026-12-01', 1_000_000_000)];
  assert.equal(buildReplenishment(receipts).items[0].status, 'quantity-limit');
  const loose = looseFixture();
  for (const row of loose.forecasts.puesto.series) if (row.presentationId !== 'pack') row.forecast[0].physicalUnits = 600_000_000;
  assert.equal(buildReplenishment(loose).items.find(item => item.presentationId === null)!.status, 'quantity-limit');
});

test('DDS-12: a receipt within package-count bounds is blocked when its physical pieces exceed capacity', () => {
  const input = fixture([0], [0], 0, 0);
  input.scenario.receipts = [receipt('too-many-physical-pieces', '2026-12-01', 1_000_000_000)];
  const before = structuredClone(input);
  const plan = buildReplenishment(input);
  assert.equal(plan.items[0].status, 'quantity-limit');
  assert.deepEqual(plan.items[0].months, []);
  assert.ok(plan.items[0].warnings.some(message => message.includes('límite seguro')));
  assert.deepEqual(input, before);
  assert.ok(plan.assumptions.some(message => message.includes('todas las presentaciones')));
});

test('DDS-12: pure planning preserves inputs and identifies conditional balances and rounding assumptions', () => {
  const input = fixture([20, 21, 19], [2, 3, 2], 8, 20);
  input.scenario.leadTimeDays = 14;
  input.scenario.reservePercent = 2.5;
  input.forecasts.puesto.series[0].warnings = ['Cambió el tamaño de esta presentación.'];
  input.forecasts.almacen.series[0].warnings = ['Cambió el tamaño de esta presentación.'];
  input.forecasts.puesto.series[0].forecast[0].physicalUnits = 2001;
  const before = structuredClone(input);
  const plan = buildReplenishment(input);
  assert.deepEqual(input, before);
  assert.equal(plan.items[0].months[0].demand.puesto, 21);
  assert.equal(plan.items[0].months[0].reserve.puesto, 1);
  assert.equal(plan.items[0].warnings.filter(message => message.includes('Cambió el tamaño')).length, 1);
  assert.ok(plan.assumptions.some(message => message.includes('condicionales')));
  assert.ok(plan.assumptions.some(message => message.includes('mes parcial')));
  assert.ok(plan.assumptions.some(message => message.includes('No se abren empaques')));
  assert.deepEqual(buildReplenishment(input), plan);
});
