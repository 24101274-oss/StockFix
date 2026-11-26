import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildForecast } from '../forecast/engine';
import type { ForecastInput, ForecastQuery } from '../../shared/forecast';
import { SYNTHETIC_DATA_LABEL, type SyntheticManifest } from '../../shared/demo-dataset';
import type { Product, Sale, SaleItem } from '../../shared/types';

function product(units = 1): Product {
  return { id: 'product', sku: 'DEMO-1', name: 'Producto DEMO', category: 'Prueba', brand: 'DEMO', barcode: null, active: true,
    stock: { puesto: 0, almacen: 0 }, presentations: [{ id: 'presentation', label: 'Presentación actual', units, priceCents: 100 }], sourceNotes: [] };
}

function monthAt(ordinal: number): string {
  return `${Math.floor(ordinal / 12)}-${String(ordinal % 12 + 1).padStart(2, '0')}`;
}

function sale(createdAt: string, units: number, changes: Partial<SaleItem> = {}): Sale {
  const item: SaleItem = { productId: 'product', presentationId: 'presentation', name: 'Producto DEMO', presentationLabel: 'Presentación histórica',
    location: 'puesto', quantity: units, units, unitPriceCents: 100, totalCents: units * 100, ...changes };
  return { id: `sale-${createdAt}-${units}`, number: 'PR-DEMO', documentType: 'ticket', status: 'PRUEBA', createdAt,
    userName: SYNTHETIC_DATA_LABEL, customer: null, paymentMethod: 'efectivo', totalCents: item.totalCents,
    paidCents: item.totalCents, changeCents: 0, cancelled: false, items: [item] };
}

function fixture(values: number[], start = '2025-01', query: Partial<ForecastQuery> = {}): ForecastInput {
  const first = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1;
  const cutoff = `${monthAt(first + values.length)}-15`;
  const manifest: SyntheticManifest = {
    id: 'synthetic-v1-test', kind: 'synthetic', label: SYNTHETIC_DATA_LABEL, version: 1, seed: 'forecast-fixture', asOfDate: cutoff,
    timeZone: 'America/Lima', historyStart: `${start}-01`, lastCompleteMonth: monthAt(first + values.length - 1),
    completeMonths: values.length, observedThrough: cutoff, units: 'physical-items',
    coverage: [{ productId: 'product', introducedOn: `${start}-01`, observedFrom: `${start}-01`, observedThrough: cutoff, pattern: 'Prueba' }],
    counts: { products: 1, sales: values.filter(value => value > 0).length, purchases: 0, stockMovements: 0, cashSessions: 0 }, dataSha256: 'fixture',
  };
  return { products: [product()], sales: values.flatMap((value, index) => value > 0 ? [sale(`${monthAt(first + index)}-01T17:00:00.000Z`, value)] : []),
    manifest, query: { cutoff, horizon: 3, location: 'all', ...query } };
}

test('DDS-11: model comparison uses three strictly past one-step folds and baseline-first ties', () => {
  const input = fixture([10, 10, 10, 10, 20, 100]);
  const series = buildForecast(input).series[0];
  assert.equal(series.method, 'last-month');
  assert.deepEqual(series.evaluation?.months, ['2025-04', '2025-05', '2025-06']);
  assert.equal(series.evaluation?.folds, 3);
  assert.equal(series.evaluation?.baselineMae, 30);
  assert.deepEqual(series.evaluation?.candidates.find(candidate => candidate.method === 'last-month'), { method: 'last-month', mae: 30, bias: -30 });
  assert.deepEqual(series.evaluation?.candidates.find(candidate => candidate.method === 'moving-average-3'), { method: 'moving-average-3', mae: 97 / 3, bias: -97 / 3 });
  assert.deepEqual(series.evaluation?.candidates.find(candidate => candidate.method === 'linear-trend'), { method: 'linear-trend', mae: 92 / 3, bias: -92 / 3 });
  const constant = buildForecast(fixture([17, 17, 17, 17, 17, 17])).series[0];
  assert.equal(constant.method, 'last-month');
  assert.equal(constant.evaluation?.mae, 0);
});

test('DDS-11: trend forecasts account for the unfitted cutoff month and cross the Lima year boundary', () => {
  const input = fixture([10, 20, 30, 40, 50, 60], '2026-05', { cutoff: '2026-11-26' });
  const series = buildForecast(input).series[0];
  assert.equal(series.method, 'linear-trend');
  assert.equal(series.evaluation?.mae, 0);
  assert.deepEqual(series.forecast, [
    { month: '2026-12', physicalUnits: 80, presentationQuantity: 80 },
    { month: '2027-01', physicalUnits: 90, presentationQuantity: 90 },
    { month: '2027-02', physicalUnits: 100, presentationQuantity: 100 },
  ]);
  input.manifest!.coverage[0].observedThrough = '2026-10-31';
  input.manifest!.observedThrough = '2026-10-31';
  input.query.cutoff = '2027-01-10';
  const later = buildForecast(input).series[0];
  assert.equal(later.forecast[0].month, '2027-02');
  assert.equal(later.forecast[0].physicalUnits, 100);
  assert.ok(later.warnings.some(warning => warning.includes('no se completan con ceros')));
});

test('DDS-11: seasonal-naive competes only when every validation fold has twelve prior months', () => {
  const seasonal = [7, 60, 12, 90, 4, 130, 30, 55, 150, 18, 200, 80];
  const input = fixture([...seasonal, ...seasonal]);
  const series = buildForecast(input).series[0];
  assert.equal(series.method, 'seasonal-naive');
  assert.equal(series.evaluation?.mae, 0);
  assert.deepEqual(series.forecast.map(point => point.physicalUnits), [60, 12, 90]);
  assert.equal(buildForecast(fixture([...seasonal, 7, 60])).series[0].evaluation?.candidates.some(candidate => candidate.method === 'seasonal-naive'), false);
  assert.equal(buildForecast(fixture([...seasonal, 7, 60, 12])).series[0].evaluation?.candidates.some(candidate => candidate.method === 'seasonal-naive'), true);
});

test('DDS-11: known coverage fills observed zeros and excludes months before product introduction', () => {
  const input = fixture([0, 0, 0, 0, 0, 0]);
  const zero = buildForecast(input).series[0];
  assert.deepEqual(zero.history.map(point => point.physicalUnits), [0, 0, 0, 0, 0, 0]);
  assert.equal(zero.method, 'last-month');
  assert.ok(zero.forecast.every(point => point.physicalUnits === 0));
  input.manifest!.coverage[0].introducedOn = '2025-04-01';
  input.manifest!.coverage[0].observedFrom = '2025-04-01';
  const recent = buildForecast(input).series[0];
  assert.deepEqual(recent.history.map(point => point.month), ['2025-04', '2025-05', '2025-06']);
  assert.equal(recent.method, 'moving-average-3');
  assert.equal(recent.evaluation, null);
  input.manifest!.coverage[0].introducedOn = '2025-04-10';
  const incompleteFirst = buildForecast(input).series[0];
  assert.deepEqual(incompleteFirst.history.map(point => point.month), ['2025-05', '2025-06']);
  assert.equal(incompleteFirst.status, 'insufficient-history');
  assert.deepEqual(incompleteFirst.forecast, []);
  input.manifest!.coverage = [];
  assert.deepEqual(buildForecast(input).series[0].history, []);
});

test('DDS-11: recorded data excludes its incomplete first month and declares continuous recording assumptions', () => {
  const input = fixture([5, 0, 0, 0, 10]);
  input.manifest = null;
  input.sales[0].createdAt = '2025-01-15T17:00:00.000Z';
  const report = buildForecast(input);
  const series = report.series[0];
  assert.equal(report.source.kind, 'recorded');
  assert.equal(report.source.datasetId, null);
  assert.deepEqual(series.history, [
    { month: '2025-02', physicalUnits: 0 }, { month: '2025-03', physicalUnits: 0 },
    { month: '2025-04', physicalUnits: 0 }, { month: '2025-05', physicalUnits: 10 },
  ]);
  assert.ok(series.warnings.some(warning => warning.includes('registro continuo')));
  assert.equal(series.evaluation, null);
  input.sales = [];
  assert.equal(buildForecast(input).series[0].status, 'insufficient-history');
});

test('DDS-11: a partial month and future or cancelled sales never influence fitted models', () => {
  const input = fixture([10, 20, 30, 40, 50, 60], '2026-05', { cutoff: '2026-11-26' });
  const original = buildForecast(input).series[0];
  input.sales.push(sale('2026-11-26T17:00:00.000Z', 100000), sale('2026-11-27T17:00:00.000Z', 999999), sale('2026-12-01T17:00:00.000Z', 999999));
  const cancelled = sale('2026-10-25T17:00:00.000Z', 999999);
  cancelled.cancelled = true;
  input.sales.push(cancelled);
  const result = buildForecast(input).series[0];
  assert.deepEqual(result.history, original.history);
  assert.deepEqual(result.evaluation, original.evaluation);
  assert.deepEqual(result.forecast, original.forecast);
  assert.deepEqual(result.partial, { month: '2026-11', physicalUnits: 100000 });
});

test('DDS-11: Lima UTC offset and leap-day coverage assign pieces to the correct calendar month', () => {
  const input = fixture([7, 7, 7, 7], '2025-09', { cutoff: '2026-01-03' });
  input.manifest!.observedThrough = '2026-01-03';
  input.manifest!.coverage[0].observedThrough = '2026-01-03';
  input.sales.push(sale('2026-01-01T02:00:00.000Z', 70), sale('2026-01-01T05:00:00.000Z', 13));
  const result = buildForecast(input).series[0];
  assert.equal(result.history.at(-1)?.physicalUnits, 77);
  assert.deepEqual(result.partial, { month: '2026-01', physicalUnits: 13 });
  const leap = fixture([4, 4, 4, 4], '2023-11', { cutoff: '2024-03-01' });
  leap.manifest!.observedThrough = '2024-03-01';
  leap.manifest!.coverage[0].observedThrough = '2024-03-01';
  leap.sales.push(sale('2024-02-29T17:00:00.000Z', 20));
  assert.equal(buildForecast(leap).series[0].history.at(-1)?.physicalUnits, 24);
  assert.throws(() => buildForecast({ ...leap, query: { ...leap.query, cutoff: '2025-02-29' } }), /fecha válida/);
});

test('DDS-11: package snapshots already contain total pieces and current equivalents round upward', () => {
  const input = fixture([200, 200, 200, 200, 200, 200]);
  input.products = [product(100)];
  for (const row of input.sales) row.items[0].quantity = 2;
  const before = structuredClone(input);
  const report = buildForecast(input);
  assert.deepEqual(input, before);
  assert.ok(report.series[0].history.every(point => point.physicalUnits === 200));
  assert.ok(report.series[0].forecast.every(point => point.physicalUnits === 200 && point.presentationQuantity === 2));
  input.products[0].presentations[0].units = 60;
  const resized = buildForecast(input).series[0];
  assert.ok(resized.warnings.some(warning => warning.includes('Cambió el tamaño')));
  assert.ok(resized.forecast.every(point => point.physicalUnits === 200 && point.presentationQuantity === 4));
});

test('DDS-11: filter by current presentation and location while warning about invalid and removed lines', () => {
  const input = fixture([10, 10, 10, 10, 10, 10]);
  const other = input.sales.map(row => sale(row.createdAt, 20, { location: 'almacen' }));
  input.sales.push(...other);
  assert.ok(buildForecast(input).series[0].forecast.every(point => point.physicalUnits === 30));
  input.query.location = 'puesto';
  assert.ok(buildForecast(input).series[0].forecast.every(point => point.physicalUnits === 10));
  input.query.location = 'almacen';
  assert.ok(buildForecast(input).series[0].forecast.every(point => point.physicalUnits === 20));
  input.query.location = 'all';
  input.sales.push(sale('2025-05-10T17:00:00.000Z', 0), sale('2025-05-10T17:00:00.000Z', 2, { quantity: 3 }),
    sale('2025-05-10T17:00:00.000Z', 100, { presentationId: 'retirada' }), sale('2025-02-30T17:00:00.000Z', 99999));
  const result = buildForecast(input);
  assert.ok(result.series[0].warnings.some(warning => warning.includes('retiradas')));
  assert.ok(result.series[0].warnings.some(warning => warning.includes('2 líneas')));
  assert.ok(result.warnings.some(warning => warning.includes('fecha o detalle inválido')));
  assert.ok(result.series[0].history.every(point => point.physicalUnits === 30));
  input.products[0].active = false;
  assert.deepEqual(buildForecast(input).series, []);
});

test('DDS-11: cap history at sixty complete months and round declining trends to nonnegative integers', () => {
  const long = fixture(Array.from({ length: 72 }, (_, index) => index + 1), '2020-01');
  const series = buildForecast(long).series[0];
  assert.equal(series.history.length, 60);
  assert.equal(series.history[0].month, '2021-01');
  const declining = buildForecast(fixture([60, 50, 40, 30, 20, 10])).series[0];
  assert.equal(declining.method, 'linear-trend');
  assert.ok(declining.forecast.every(point => point.physicalUnits === 0));
  for (const horizon of [0, 13, 1.5, NaN]) assert.throws(() => buildForecast({ ...long, query: { ...long.query, horizon } }), /horizonte/);
  assert.throws(() => buildForecast({ ...long, query: { ...long.query, cutoff: '9999-12-01' } }), /año 9999/);
});

test('DDS-11: nonfinite and unsafe physical counts are omitted instead of contaminating forecasts', () => {
  const input = fixture([10, 10, 10, 10, 10, 10]);
  for (const units of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) input.sales.push(sale('2025-04-15T17:00:00.000Z', units, { quantity: 1 }));
  const series = buildForecast(input).series[0];
  assert.ok(series.history.every(point => point.physicalUnits === 10));
  assert.ok(series.forecast.every(point => point.physicalUnits === 10));
  assert.ok(series.warnings.some(warning => warning.includes('3 líneas')));
});
