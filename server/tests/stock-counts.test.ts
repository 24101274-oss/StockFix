import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Product, StockMovement } from '../../shared/types';
import { buildApp } from '../app';

const product = (id: string, presentations = [
  { id: 'paquete', label: 'Paquete de 100', units: 100, priceCents: 250 },
  { id: 'millar', label: 'Millar', units: 1000, priceCents: 2400 },
  { id: 'fardo', label: 'Fardo de 50 paquetes', units: 5000, priceCents: 11000 },
]): Product => ({ id, sku: id, name: `Bolsas ${id}`, brand: '', category: 'Bolsas', barcode: null, active: true,
  stock: { puesto: null, almacen: null }, presentations, sourceNotes: [] });

let app: FastifyInstance;
let adminCookie: string;
let cashierCookie: string;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, cookie = adminCookie) => app.inject({
  method, url: `/api${url}`, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }),
});
const adjust = (productId: string, counts: unknown, location = 'puesto') => ({ productId, location, counts, reason: 'Conteo físico comprobado' });
const transfer = (productId: string, counts: unknown) => ({ productId, from: 'puesto', to: 'almacen', counts, reason: 'Reposición comprobada' });
const getProduct = async (id: string) => (await call('GET', '/products')).json<Product[]>().find(item => item.id === id)!;
const state = async (id: string) => ({ product: await getProduct(id), movements: (await call('GET', '/stock/movements')).json<StockMovement[]>() });
const setUnits = async (id: string, puesto: number, almacen: number) => {
  for (const [location, quantityUnits] of [['puesto', puesto], ['almacen', almacen]] as const) {
    const response = await call('POST', '/stock/adjust', { productId: id, location, quantityUnits, reason: 'Preparación de existencias' });
    assert.equal(response.statusCode, 200, response.body);
  }
};
const setPackages = async (id: string, puesto: { presentationId: string | null; quantity: number }[], almacen: { presentationId: string | null; quantity: number }[]) => {
  for (const [location, counts] of [['puesto', puesto], ['almacen', almacen]] as const) {
    const response = await call('POST', '/stock/adjust', adjust(id, counts, location));
    assert.equal(response.statusCode, 200, response.body);
  }
};
const physicalQuantity = (product: Product, location: 'puesto' | 'almacen', presentationId: string | null) => product.stockByPresentation?.[location]?.find(item => item.presentationId === presentationId)?.quantity;

before(async () => {
  app = await buildApp({ seed: [
    ...['paquetes', 'mixto', 'validacion', 'cambios', 'traslado', 'limites', 'concurrencia', 'sinpresentaciones', 'operaciones', 'legacy'].map(id => product(id, id === 'sinpresentaciones' ? [] : undefined)),
    product('unitarios', [{ id: 'unidad', label: 'Unidad', units: 1, priceCents: 25 }, { id: 'unidad_alt', label: 'Unidad precio especial', units: 1, priceCents: 20 }, { id: 'paquete', label: 'Paquete de 100', units: 100, priceCents: 250 }]),
  ], lookup: { token: '' } });
  for (const [email, password] of [['admin@stockfix.local', 'AdminDemo2026!'], ['cajero@stockfix.local', 'CajeroDemo2026!']]) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    if (email.startsWith('admin')) adminCookie = cookie; else cashierCookie = cookie;
  }
});
after(async () => { await app.close(); });

test('counting thirty packages records 3000 base units and a single initial movement', async () => {
  const response = await call('POST', '/stock/adjust', adjust('paquetes', [{ presentationId: 'paquete', quantity: 30 }]));
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().stock, { puesto: 3000, almacen: null });
  assert.equal(physicalQuantity(response.json(), 'puesto', 'paquete'), 30);
  assert.equal(physicalQuantity(response.json(), 'puesto', 'fardo'), 0);
  const movements = (await state('paquetes')).movements.filter(item => item.productId === 'paquetes');
  assert.equal(movements.length, 1);
  assert.equal(movements[0].quantityUnits, 3000);
  assert.equal(movements[0].type, 'conteo_inicial');
});

test('mixed fardos, packages and loose units sum once without counting equivalent stock twice', async () => {
  const response = await call('POST', '/stock/adjust', adjust('mixto', [
    { presentationId: 'fardo', quantity: 2 }, { presentationId: 'paquete', quantity: 3 }, { presentationId: null, quantity: 17 },
  ], 'almacen'));
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().stock, { puesto: null, almacen: 10317 });
  const zero = await call('POST', '/stock/adjust', adjust('mixto', [{ presentationId: 'fardo', quantity: 0 }], 'almacen'));
  assert.equal(zero.statusCode, 200, zero.body);
  assert.equal(zero.json().stock.almacen, 0);
  const movement = (await state('mixto')).movements.find(item => item.productId === 'mixto' && item.type === 'ajuste');
  assert.equal(movement?.quantityUnits, -10317);
  const looseOnly = await call('POST', '/stock/adjust', adjust('sinpresentaciones', [{ presentationId: null, quantity: 7 }]));
  assert.equal(looseOnly.statusCode, 200, looseOnly.body);
  assert.equal(looseOnly.json().stock.puesto, 7);
});

test('malformed, duplicate, fractional and ambiguous count inputs leave stock and history unchanged', async () => {
  await setUnits('validacion', 500, 0);
  const baseline = await state('validacion');
  const invalid = [
    adjust('validacion', []),
    adjust('validacion', [{ presentationId: 'paquete', quantity: -1 }]),
    adjust('validacion', [{ presentationId: 'paquete', quantity: 0.5 }]),
    adjust('validacion', [{ presentationId: 'paquete', quantity: '2' }]),
    adjust('validacion', [{ presentationId: 'paquete', quantity: 2 }, { presentationId: 'paquete', quantity: 1 }]),
    adjust('validacion', [{ presentationId: null, quantity: 2 }, { presentationId: null, quantity: 3 }]),
    adjust('validacion', [{ presentationId: 'paquete', quantity: 2, units: 1 }]),
    { ...adjust('validacion', [{ presentationId: 'paquete', quantity: 2 }]), quantityUnits: 2 },
    { productId: 'validacion', location: 'puesto', reason: 'Sin cantidad' },
    adjust('validacion', Array.from({ length: 22 }, (_, i) => ({ presentationId: `presentacion-${i}`, quantity: 1 }))),
  ];
  for (const payload of invalid) {
    const response = await call('POST', '/stock/adjust', payload);
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(await state('validacion'), baseline);
  }
});

test('unknown and deleted presentations reject a stale count, including zero rows', async () => {
  const baseline = await state('cambios');
  for (const quantity of [0, 2]) {
    const response = await call('POST', '/stock/adjust', adjust('cambios', [{ presentationId: 'paquete', quantity: 1 }, { presentationId: 'faltante', quantity }]));
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(await state('cambios'), baseline);
  }
  const current = await getProduct('cambios');
  const { name, brand, category, barcode, active } = current;
  const updated = await call('PATCH', '/products/cambios', { name, brand, category, barcode, active,
    presentations: [{ id: 'paquete', label: 'Paquete actualizado', units: 200, priceCents: 500 }],
  });
  assert.equal(updated.statusCode, 200, updated.body);
  const stale = await call('POST', '/stock/adjust', adjust('cambios', [{ presentationId: 'fardo', quantity: 1 }]));
  assert.equal(stale.statusCode, 409, stale.body);
  const counted = await call('POST', '/stock/adjust', adjust('cambios', [{ presentationId: 'paquete', quantity: 3 }]));
  assert.equal(counted.statusCode, 200, counted.body);
  assert.equal(counted.json().stock.puesto, 600);
});

test('conversion and accumulation limits are checked before storing a count', async () => {
  const baseline = await state('limites');
  for (const counts of [
    [{ presentationId: 'fardo', quantity: 200001 }],
    [{ presentationId: 'fardo', quantity: 200000 }, { presentationId: null, quantity: 1 }],
    [{ presentationId: 'fardo', quantity: 1_000_000_000 }],
  ]) {
    const response = await call('POST', '/stock/adjust', adjust('limites', counts));
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(await state('limites'), baseline);
  }
  const maximum = await call('POST', '/stock/adjust', adjust('limites', [{ presentationId: null, quantity: 1_000_000_000 }]));
  assert.equal(maximum.statusCode, 200, maximum.body);
  assert.equal(maximum.json().stock.puesto, 1_000_000_000);
});

test('presentation transfers conserve stock and create matching source and destination movements', async () => {
  await setPackages('traslado', [{ presentationId: 'fardo', quantity: 2 }, { presentationId: 'paquete', quantity: 19 }, { presentationId: null, quantity: 100 }], [{ presentationId: 'paquete', quantity: 2 }]);
  const response = await call('POST', '/stock/transfer', transfer('traslado', [
    { presentationId: 'fardo', quantity: 1 }, { presentationId: 'paquete', quantity: 2 }, { presentationId: null, quantity: 3 },
  ]));
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().stock, { puesto: 6797, almacen: 5403 });
  assert.equal(response.json().stock.puesto + response.json().stock.almacen, 12200);
  assert.equal(physicalQuantity(response.json(), 'puesto', 'fardo'), 1);
  assert.equal(physicalQuantity(response.json(), 'almacen', 'fardo'), 1);
  assert.equal(physicalQuantity(response.json(), 'puesto', 'paquete'), 17);
  assert.equal(physicalQuantity(response.json(), 'almacen', 'paquete'), 4);
  assert.equal(physicalQuantity(response.json(), 'puesto', null), 97);
  assert.equal(physicalQuantity(response.json(), 'almacen', null), 3);
  const movements = (await state('traslado')).movements.filter(item => item.productId === 'traslado' && item.type.startsWith('traslado_'));
  assert.equal(movements.length, 2);
  assert.equal(movements.find(item => item.location === 'puesto')?.quantityUnits, -5203);
  assert.equal(movements.find(item => item.location === 'almacen')?.quantityUnits, 5203);
});

test('failed transfers preserve both locations and their movement history', async () => {
  await setPackages('traslado', [{ presentationId: 'paquete', quantity: 10 }], [{ presentationId: null, quantity: 1_000_000_000 }]);
  const baseline = await state('traslado');
  for (const [payload, code] of [
    [transfer('traslado', [{ presentationId: null, quantity: 0 }]), 400],
    [transfer('traslado', [{ presentationId: 'fardo', quantity: 1 }]), 409],
    [transfer('traslado', [{ presentationId: 'paquete', quantity: 1 }]), 400],
    [transfer('traslado', [{ presentationId: 'fardo', quantity: 201 }]), 400],
    [transfer('traslado', [{ presentationId: 'eliminada', quantity: 1 }]), 409],
    [{ ...transfer('traslado', [{ presentationId: 'paquete', quantity: 1 }]), to: 'puesto' }, 400],
    [{ ...transfer('traslado', [{ presentationId: 'paquete', quantity: 1 }]), quantityUnits: 100 }, 400],
  ] as const) {
    const response = await call('POST', '/stock/transfer', payload);
    assert.equal(response.statusCode, code, response.body);
    assert.deepEqual(await state('traslado'), baseline);
  }
  const uncounted = await call('POST', '/stock/transfer', transfer('sinpresentaciones', [{ presentationId: null, quantity: 1 }]));
  assert.equal(uncounted.statusCode, 409, uncounted.body);
});

test('simultaneous presentation transfers cannot consume the same stock twice', async () => {
  await setPackages('concurrencia', [{ presentationId: 'paquete', quantity: 10 }], [{ presentationId: null, quantity: 0 }]);
  const responses = await Promise.all([1, 2].map(() => call('POST', '/stock/transfer', transfer('concurrencia', [{ presentationId: 'paquete', quantity: 6 }]))));
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
  assert.deepEqual((await getProduct('concurrencia')).stock, { puesto: 400, almacen: 600 });
  assert.equal((await state('concurrencia')).movements.filter(item => item.productId === 'concurrencia' && item.type.startsWith('traslado_')).length, 2);
});

test('a physical presentation cannot be transferred using the stock of another presentation', async () => {
  await setPackages('traslado', [{ presentationId: 'fardo', quantity: 2 }], [{ presentationId: null, quantity: 0 }]);
  const baseline = await state('traslado');
  const response = await call('POST', '/stock/transfer', transfer('traslado', [{ presentationId: 'paquete', quantity: 1 }]));
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(await state('traslado'), baseline);
});

test('purchases add exact packages and idempotent sales subtract exact packages without implicitly opening fardos', async () => {
  await setPackages('operaciones', [{ presentationId: 'fardo', quantity: 1 }], [{ presentationId: null, quantity: 0 }]);
  assert.equal((await call('POST', '/cash/open', { openingCents: 0 })).statusCode, 200);
  const sale = { idempotencyKey: randomUUID(), documentType: 'ticket', customerId: null, paymentMethod: 'yape', paidCents: 250,
    items: [{ productId: 'operaciones', presentationId: 'paquete', quantity: 1, location: 'puesto' }] };
  const beforeSale = await state('operaciones');
  const beforeCash = (await call('GET', '/cash')).json();
  const unavailable = await call('POST', '/sales', sale, cashierCookie);
  assert.equal(unavailable.statusCode, 409, unavailable.body);
  assert.deepEqual(await state('operaciones'), beforeSale);
  assert.deepEqual((await call('GET', '/cash')).json(), beforeCash);
  assert.equal((await call('GET', '/sales')).json().length, 0);
  const supplier = await call('POST', '/suppliers', { ruc: '20999999990', name: 'Proveedor de empaques de prueba', address: '', phone: '' });
  assert.equal(supplier.statusCode, 200, supplier.body);
  const purchase = { idempotencyKey: randomUUID(), supplierId: supplier.json().id, document: 'COMPRA-PAQUETES', location: 'puesto', paymentMethod: 'yape', paidFromCash: false, totalPaidCents: null,
    items: [{ productId: 'operaciones', presentationId: 'paquete', quantity: 3, unitCostCents: null }] };
  const received = await call('POST', '/purchases', purchase);
  assert.equal(received.statusCode, 200, received.body);
  assert.equal((await call('POST', '/purchases', purchase)).json().id, received.json().id);
  const afterPurchase = await getProduct('operaciones');
  assert.equal(afterPurchase.stock.puesto, 5300);
  assert.equal(physicalQuantity(afterPurchase, 'puesto', 'fardo'), 1);
  assert.equal(physicalQuantity(afterPurchase, 'puesto', 'paquete'), 3);
  const sold = await call('POST', '/sales', sale, cashierCookie);
  assert.equal(sold.statusCode, 200, sold.body);
  assert.equal((await call('POST', '/sales', sale, cashierCookie)).json().id, sold.json().id);
  const afterSale = await getProduct('operaciones');
  assert.equal(afterSale.stock.puesto, 5200);
  assert.equal(physicalQuantity(afterSale, 'puesto', 'paquete'), 2);
  assert.equal(physicalQuantity(afterSale, 'puesto', 'fardo'), 1);
  assert.equal((await call('GET', '/cash')).json().payments.yape, 250);
  const baseline = await state('operaciones');
  const overflow = await call('POST', '/purchases', { ...purchase, idempotencyKey: randomUUID(), items: [{ productId: 'operaciones', presentationId: 'fardo', quantity: 1_000_000, unitCostCents: null }] });
  assert.equal(overflow.statusCode, 400, overflow.body);
  assert.deepEqual(await state('operaciones'), baseline);
  assert.equal((await call('GET', '/purchases')).json().length, 1);
});

test('legacy counts and transfers preserve totals without inventing a physical packaging breakdown', async () => {
  await setPackages('legacy', [{ presentationId: 'paquete', quantity: 10 }], [{ presentationId: 'paquete', quantity: 1 }]);
  const legacyCount = await call('POST', '/stock/adjust', { productId: 'legacy', location: 'puesto', quantityUnits: 500, reason: 'Conteo legacy' });
  assert.equal(legacyCount.statusCode, 200, legacyCount.body);
  assert.equal(legacyCount.json().stockByPresentation.puesto, null);
  assert.equal(physicalQuantity(legacyCount.json(), 'almacen', 'paquete'), 1);
  const noBreakdown = await call('POST', '/stock/transfer', transfer('legacy', [{ presentationId: 'paquete', quantity: 1 }]));
  assert.equal(noBreakdown.statusCode, 409, noBreakdown.body);
  const moved = await call('POST', '/stock/transfer', { productId: 'legacy', from: 'puesto', to: 'almacen', quantityUnits: 200, reason: 'Traslado legacy' });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.deepEqual(moved.json().stock, { puesto: 300, almacen: 300 });
  assert.deepEqual(moved.json().stockByPresentation, { puesto: null, almacen: null });
});

test('single-unit presentation aliases and loose units share one physical balance across counting, transfer, sale and purchase', async () => {
  await setPackages('unitarios', [{ presentationId: 'unidad', quantity: 10 }, { presentationId: null, quantity: 5 }], [{ presentationId: null, quantity: 0 }]);
  const counted = await getProduct('unitarios');
  assert.equal(counted.stock.puesto, 15);
  assert.equal(physicalQuantity(counted, 'puesto', null), 15);
  assert.equal(counted.stockByPresentation?.puesto?.some(item => item.presentationId === 'unidad'), false);
  const moved = await call('POST', '/stock/transfer', transfer('unitarios', [{ presentationId: 'unidad_alt', quantity: 4 }]));
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(physicalQuantity(moved.json(), 'puesto', null), 11);
  assert.equal(physicalQuantity(moved.json(), 'almacen', null), 4);
  const sold = await call('POST', '/sales', { idempotencyKey: randomUUID(), documentType: 'ticket', customerId: null, paymentMethod: 'yape', paidCents: 75,
    items: [{ productId: 'unitarios', presentationId: 'unidad', quantity: 3, location: 'puesto' }] }, cashierCookie);
  assert.equal(sold.statusCode, 200, sold.body);
  const suppliers = (await call('GET', '/suppliers')).json();
  const received = await call('POST', '/purchases', { idempotencyKey: randomUUID(), supplierId: suppliers[0].id, document: 'UNIDADES-SUELTAS', location: 'puesto', paymentMethod: 'yape', paidFromCash: false, totalPaidCents: null,
    items: [{ productId: 'unitarios', presentationId: 'unidad_alt', quantity: 2, unitCostCents: null }] });
  assert.equal(received.statusCode, 200, received.body);
  const result = await getProduct('unitarios');
  assert.deepEqual(result.stock, { puesto: 10, almacen: 4 });
  assert.equal(physicalQuantity(result, 'puesto', null), 10);
  assert.equal(physicalQuantity(result, 'almacen', null), 4);
});

test('presentation count and transfer operations retain administrator-only access', async () => {
  const baseline = await state('paquetes');
  for (const endpoint of ['/stock/adjust', '/stock/transfer']) {
    const payload = endpoint.endsWith('adjust') ? adjust('paquetes', [{ presentationId: 'paquete', quantity: 1 }]) : transfer('paquetes', [{ presentationId: 'paquete', quantity: 1 }]);
    assert.equal((await call('POST', endpoint, payload, '')).statusCode, 401);
    assert.equal((await call('POST', endpoint, payload, cashierCookie)).statusCode, 403);
  }
  assert.deepEqual(await state('paquetes'), baseline);
});
