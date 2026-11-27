import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Presentation, PresentationCount, Product } from '../../shared/types.js';
import { countStockUnits, getPackagingStock, normalizePresentationCounts, quantityInPresentation } from '../../shared/stock-packaging.js';

const presentations: Presentation[] = [
  { id: 'package', label: 'Paquete de 100', units: 100, priceCents: 250 },
  { id: 'bundle', label: 'Fardo de 50 paquetes', units: 5000, priceCents: 11000 },
  { id: 'thousand', label: 'Millar', units: 1000, priceCents: 2400 },
];
const counts: PresentationCount[] = [
  { presentationId: 'package', quantity: 30 },
  { presentationId: 'bundle', quantity: 2 },
  { presentationId: 'thousand', quantity: 3 },
  { presentationId: null, quantity: 15 },
];
function product(overrides: Partial<Product> = {}): Product {
  return { id: 'bags', sku: 'PR-P-001', name: 'Bolsas PRUEBA', brand: '', category: '', barcode: null, active: true,
    stock: { puesto: 16015, almacen: null }, presentations, sourceNotes: [],
    stockByPresentation: { puesto: counts, almacen: null }, ...overrides };
}

test('separate physical counts add packages, bundles, thousands and loose units once each', () => {
  assert.equal(countStockUnits(presentations, counts), 16015);
  const item = product();
  assert.equal(quantityInPresentation(item, 'puesto', 'package'), 30);
  assert.equal(quantityInPresentation(item, 'puesto', 'bundle'), 2);
  assert.equal(quantityInPresentation(item, 'puesto', 'thousand'), 3);
  assert.equal(quantityInPresentation(item, 'puesto', null), 15);
  assert.equal(quantityInPresentation(item, 'puesto', 'unknown'), 0);
  assert.equal(countStockUnits([], [{ presentationId: null, quantity: 30 }]), 30);
});

test('normalization preserves actual recorded quantities and fills uncounted presentations with zero', () => {
  const input = [{ presentationId: 'bundle', quantity: 1 }];
  const normalized = normalizePresentationCounts(presentations, input);
  assert.deepEqual(normalized, [
    { presentationId: 'package', quantity: 0 },
    { presentationId: 'bundle', quantity: 1 },
    { presentationId: 'thousand', quantity: 0 },
    { presentationId: null, quantity: 0 },
  ]);
  assert.equal(countStockUnits(presentations, normalized), 5000);
  assert.deepEqual(input, [{ presentationId: 'bundle', quantity: 1 }]);
  normalized[1].quantity = 2;
  assert.equal(input[0].quantity, 1);
  assert.deepEqual(normalizePresentationCounts([], []), [{ presentationId: null, quantity: 0 }]);
});

test('unit sale presentations and loose individual units share one canonical physical balance', () => {
  const withUnits = [...presentations,
    { id: 'unit', label: 'Unidad', units: 1, priceCents: 10 },
    { id: 'unit-offer', label: 'Unidad promoción', units: 1, priceCents: 9 },
  ];
  const input = [
    { presentationId: 'package', quantity: 1 },
    { presentationId: 'unit', quantity: 4 },
    { presentationId: 'unit-offer', quantity: 2 },
    { presentationId: null, quantity: 3 },
  ];
  const normalized = normalizePresentationCounts(withUnits, input);
  assert.equal(countStockUnits(withUnits, input), 109);
  assert.deepEqual(normalized, [
    { presentationId: 'package', quantity: 1 },
    { presentationId: 'bundle', quantity: 0 },
    { presentationId: 'thousand', quantity: 0 },
    { presentationId: null, quantity: 9 },
  ]);
  assert.equal(countStockUnits(withUnits, normalized), 109);
  const counted = product({ presentations: withUnits, stock: { puesto: 109, almacen: null }, stockByPresentation: { puesto: input, almacen: null } });
  assert.deepEqual(getPackagingStock(counted, 'puesto'), normalized);
  assert.equal(quantityInPresentation(counted, 'puesto', 'unit'), 9);
  assert.equal(quantityInPresentation(counted, 'puesto', 'unit-offer'), 9);
  assert.equal(quantityInPresentation(counted, 'puesto', null), 9);
});

test('legacy and uncounted physical stock do not invent closed packages from total units', () => {
  const legacy = product({ stockByPresentation: undefined });
  assert.equal(getPackagingStock(legacy, 'puesto'), null);
  assert.equal(quantityInPresentation(legacy, 'puesto', 'package'), null);
  assert.equal(getPackagingStock(product(), 'almacen'), null);
  assert.equal(getPackagingStock(product({ stock: { puesto: null, almacen: null } }), 'puesto'), null);
  assert.equal(getPackagingStock(product({ stockByPresentation: { puesto: null, almacen: null } }), 'puesto'), null);
});

test('a confirmed zero breakdown remains known and differs from unknown stock', () => {
  const zero = product({ stock: { puesto: 0, almacen: null }, stockByPresentation: { puesto: [], almacen: null } });
  assert.deepEqual(getPackagingStock(zero, 'puesto'), [
    { presentationId: 'package', quantity: 0 },
    { presentationId: 'bundle', quantity: 0 },
    { presentationId: 'thousand', quantity: 0 },
    { presentationId: null, quantity: 0 },
  ]);
  assert.equal(quantityInPresentation(zero, 'puesto', 'package'), 0);
  assert.equal(quantityInPresentation(zero, 'almacen', 'package'), null);
});

test('inconsistent or invalid saved breakdowns are not presented as trustworthy package balances', () => {
  for (const invalidCounts of [
    [{ presentationId: 'package', quantity: 1 }],
    [{ presentationId: 'unknown', quantity: 16015 }],
    [{ presentationId: null, quantity: -1 }],
    [{ presentationId: null, quantity: 16015 }, { presentationId: null, quantity: 0 }],
  ]) {
    const invalid = product({ stockByPresentation: { puesto: invalidCounts, almacen: null } });
    assert.equal(getPackagingStock(invalid, 'puesto'), null);
    assert.equal(quantityInPresentation(invalid, 'puesto', 'package'), null);
  }
  const edited = product({ presentations: [{ ...presentations[0], units: 200 }, ...presentations.slice(1)] });
  assert.equal(getPackagingStock(edited, 'puesto'), null);
});

test('counts reject unknown ids, duplicate packaging entries and negative, fractional or unsafe quantities', () => {
  assert.throws(() => countStockUnits(presentations, [{ presentationId: 'other-product-package', quantity: 1 }]), /no pertenece/);
  assert.throws(() => countStockUnits(presentations, [{ presentationId: 'package', quantity: 1 }, { presentationId: 'package', quantity: 2 }]), /No repitas/);
  assert.throws(() => countStockUnits(presentations, [{ presentationId: null, quantity: 1 }, { presentationId: null, quantity: 2 }]), /No repitas/);
  for (const quantity of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => countStockUnits(presentations, [{ presentationId: 'package', quantity }]), /entero no negativo/);
  }
});

test('presentation definitions require unique valid ids and positive integer unit contents', () => {
  for (const units of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => countStockUnits([{ ...presentations[0], units }], []), /entero mayor que cero/);
  }
  assert.throws(() => countStockUnits([presentations[0], presentations[0]], []), /no deben repetirse/);
  assert.throws(() => countStockUnits([{ ...presentations[0], id: '' }], []), /identificador válido/);
});

test('physical totals respect their cap and never overflow safe integer arithmetic', () => {
  assert.equal(countStockUnits(presentations, [{ presentationId: 'bundle', quantity: 200000 }]), 1_000_000_000);
  assert.throws(() => countStockUnits(presentations, [{ presentationId: 'bundle', quantity: 200001 }]), /superan el límite/);
  assert.throws(() => countStockUnits(presentations, [{ presentationId: 'package', quantity: 1 }, { presentationId: null, quantity: 1 }], 100), /superan el límite/);
  assert.throws(() => countStockUnits(presentations, [{ presentationId: 'bundle', quantity: Number.MAX_SAFE_INTEGER }]), /superan el límite/);
  assert.equal(countStockUnits([], [], 0), 0);
  for (const maximum of [-1, 0.5, Infinity]) assert.throws(() => countStockUnits([], [], maximum), /límite de existencias/);
});
