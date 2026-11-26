import { createHash } from 'node:crypto';
import { SYNTHETIC_DATA_LABEL, type SyntheticDataset, type SyntheticOptions } from '../../shared/demo-dataset';
import type { CashSession, LocationId, PaymentMethod, PresentationCount, Product, Purchase, PurchaseInput, Sale, SaleInput, StockMovement, Supplier } from '../../shared/types';

const LOCATIONS: LocationId[] = ['puesto', 'almacen'];
const PAYMENT_METHODS: PaymentMethod[] = ['efectivo', 'yape', 'plin', 'transferencia'];
const SALE_DAYS = [3, 9, 15, 21, 27];
const SEASONALITY = [0.76, 0.8, 0.92, 0.95, 1.01, 0.98, 1.1, 1.05, 1, 1.08, 1.24, 1.5];
const CATALOG = [
  { key: 'bolsas', name: 'DEMO Bolsas claras', category: 'Bolsas', pack: 100, price: 400, base: 1250, pattern: 'tendencia creciente' },
  { key: 'vasos', name: 'DEMO Vasos de papel', category: 'Vasos', pack: 25, price: 900, base: 750, pattern: 'estacionalidad anual' },
  { key: 'platos', name: 'DEMO Platos de cartón', category: 'Platos', pack: 12, price: 650, base: 210, pattern: 'intermitente con ceros observados' },
  { key: 'servilletas', name: 'DEMO Servilletas blancas', category: 'Servilletas', pack: 50, price: 350, base: 1050, pattern: 'demanda estable' },
  { key: 'envases', name: 'DEMO Envases con tapa', category: 'Envases', pack: 10, price: 1100, base: 400, pattern: 'tendencia y estacionalidad anual' },
  { key: 'cubiertos', name: 'DEMO Cubiertos de madera', category: 'Cubiertos', pack: 20, price: 800, base: 280, pattern: 'producto nuevo' },
];

type OperationalData = Pick<SyntheticDataset, 'products' | 'suppliers' | 'sales' | 'purchases' | 'stockMovements' | 'cashSessions'>;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Property order is part of the manifest format. Array order remains significant. */
export function syntheticOperationalHash(dataset: OperationalData): string {
  return sha256(JSON.stringify({
    products: dataset.products,
    suppliers: dataset.suppliers,
    sales: dataset.sales,
    purchases: dataset.purchases,
    stockMovements: dataset.stockMovements,
    cashSessions: dataset.cashSessions,
  }));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validateOptions(options: SyntheticOptions): { year: number; month: number; day: number } {
  if (!options || typeof options.seed !== 'string' || !options.seed.trim()) throw new Error('La semilla debe ser un texto no vacío.');
  if (!Number.isInteger(options.months) || options.months < 12 || options.months > 60) throw new Error('El historial debe contener entre 12 y 60 meses completos.');
  const match = typeof options.asOfDate === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(options.asOfDate);
  if (!match) throw new Error('La fecha de corte debe usar YYYY-MM-DD en America/Lima.');
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new Error('La fecha de corte no existe en el calendario.');
  if (year * 12 + month - 1 - options.months < 12) throw new Error('El inicio del historial debe corresponder al año 0001 o posterior.');
  return { year, month, day };
}

function monthAt(ordinal: number): string {
  return `${String(Math.floor(ordinal / 12)).padStart(4, '0')}-${String(ordinal % 12 + 1).padStart(2, '0')}`;
}

function timestamp(date: string, limaHour: number, minute = 0): string {
  return `${date}T${String(limaHour + 5).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

function distribute(quantity: number, positions: number): number[] {
  return Array.from({ length: positions }, (_, index) => Math.floor(quantity / positions) + (index < quantity % positions ? 1 : 0));
}

/** Generate fictional operations directly, without accessing databases or current time. */
export function generateSyntheticDataset(options: SyntheticOptions): SyntheticDataset {
  const asOf = validateOptions(options);
  const currentOrdinal = asOf.year * 12 + asOf.month - 1;
  const firstOrdinal = currentOrdinal - options.months;
  const historyStart = `${monthAt(firstOrdinal)}-01`;
  const introducedOn = `${monthAt(currentOrdinal - 3)}-01`;
  const identifier = (kind: string, key: string) => `demo-${kind}-${sha256(JSON.stringify([1, options.seed, kind, key])).slice(0, 24)}`;
  const variation = (key: string) => Number.parseInt(sha256(JSON.stringify([options.seed, key])).slice(0, 8), 16) / 0x1_0000_0000;
  const products: Product[] = CATALOG.map(item => ({
    id: identifier('product', item.key), sku: `DEMO-${item.key.toUpperCase()}`, name: item.name,
    brand: 'DEMO', category: item.category, barcode: `DEMO-${item.key}`, active: true,
    stock: { puesto: 0, almacen: 0 },
    stockByPresentation: { puesto: [], almacen: [] }, minStockUnits: null,
    presentations: [
      { id: `demo-${item.key}-unidad`, label: 'Unidad DEMO', units: 1, priceCents: Math.max(1, Math.ceil(item.price / item.pack)) },
      { id: `demo-${item.key}-paquete`, label: `Paquete DEMO de ${item.pack}`, units: item.pack, priceCents: item.price },
    ],
    sourceNotes: [SYNTHETIC_DATA_LABEL, `Semilla: ${options.seed}`, 'Origen generado; no representa operaciones comerciales reales.'],
    minStockByPresentation: [{ presentationId: `demo-${item.key}-paquete`, minimum: 2 }],
  }));
  for (const product of products) {
    for (const location of LOCATIONS) {
      product.stockByPresentation![location] = [{ presentationId: product.presentations[1].id, quantity: 0 }, { presentationId: null, quantity: 0 }];
    }
  }
  const supplier: Supplier = { id: identifier('supplier', 'principal'), ruc: '20999999990', name: 'DEMO Proveedor sintético', address: 'Dirección ficticia de demostración', phone: '' };
  const operational: OperationalData = { products, suppliers: [supplier], sales: [], purchases: [], stockMovements: [], cashSessions: [] };
  let saleNumber = 0;
  let purchaseNumber = 0;

  function movement(product: Product, location: LocationId, quantityUnits: number, type: string, reason: string, createdAt: string) {
    const row: StockMovement = {
      id: identifier('movement', String(operational.stockMovements.length)), productId: product.id, productName: product.name,
      location, quantityUnits, type, reason, createdAt, userName: SYNTHETIC_DATA_LABEL,
    };
    operational.stockMovements.push(row);
    product.stock[location] = product.stock[location]! + quantityUnits;
  }

  function counts(product: Product, location: LocationId): PresentationCount[] {
    return product.stockByPresentation![location]!;
  }

  for (let monthIndex = 0; monthIndex <= options.months; monthIndex++) {
    const monthOrdinal = firstOrdinal + monthIndex;
    const month = monthAt(monthOrdinal);
    const partial = monthIndex === options.months;
    const availableDays = SALE_DAYS.filter(day => !partial || day <= asOf.day);
    const monthlyPlans = products.map((product, index) => {
      const definition = CATALOG[index];
      const observed = index !== 5 || `${month}-01` >= introducedOn;
      const monthOfYear = monthOrdinal % 12;
      const trend = 1 + monthIndex * 0.018;
      let multiplier = 1;
      if (index === 0) multiplier = trend;
      if (index === 1) multiplier = SEASONALITY[monthOfYear];
      if (index === 4) multiplier = trend * SEASONALITY[monthOfYear];
      // These are observed zero-demand months, unlike pre-introduction months.
      const zeroDemand = index === 2 && monthOrdinal % 3 === 0;
      const noise = 0.9 + variation(`${definition.key}/${month}`) * 0.2;
      let physicalUnits = observed && !zeroDemand ? Math.round(definition.base * multiplier * noise) : 0;
      if (partial) physicalUnits = Math.floor(physicalUnits * asOf.day / daysInMonth(asOf.year, asOf.month));
      if (!availableDays.length) physicalUnits = 0;
      const puestoUnits = Math.floor(physicalUnits * 0.7);
      const quantities: Record<LocationId, number[][]> = { puesto: [], almacen: [] };
      for (const location of LOCATIONS) {
        const units = location === 'puesto' ? puestoUnits : physicalUnits - puestoUnits;
        const packages = Math.floor(units / definition.pack);
        quantities[location] = [distribute(units % definition.pack, availableDays.length), distribute(packages, availableDays.length)];
      }
      return { product, observed, quantities };
    });

    for (const location of LOCATIONS) {
      const purchaseItems: PurchaseInput['items'] = [];
      for (const plan of monthlyPlans) {
        if (!plan.observed) continue;
        for (const [index, presentation] of plan.product.presentations.entries()) {
          const stockId = presentation.units === 1 ? null : presentation.id;
          const current = counts(plan.product, location).find(count => count.presentationId === stockId)!;
          const sold = plan.quantities[location][index].reduce((total, quantity) => total + quantity, 0);
          const reserve = presentation.units === 1 ? 5 : 2;
          const quantity = Math.max(0, sold + reserve - current.quantity);
          if (!quantity) continue;
          purchaseItems.push({ productId: plan.product.id, presentationId: presentation.id, quantity, unitCostCents: Math.max(1, Math.floor(presentation.priceCents * 0.6)) });
        }
      }
      if (!purchaseItems.length) continue;
      const idempotencyKey = identifier('purchase-request', `${month}/${location}`);
      const input: PurchaseInput = {
        idempotencyKey, supplierId: supplier.id, document: `DEMO-${month}-${location}`, location,
        paymentMethod: 'transferencia', paidFromCash: false,
        totalPaidCents: purchaseItems.reduce((total, item) => total + item.quantity * item.unitCostCents!, 0), items: purchaseItems,
      };
      const createdAt = timestamp(`${month}-01`, 9, location === 'puesto' ? 0 : 15);
      const purchase: Purchase = { ...input, id: identifier('purchase', `${month}/${location}`), number: `CP-${String(++purchaseNumber).padStart(6, '0')}`, createdAt, supplierName: supplier.name, userName: SYNTHETIC_DATA_LABEL };
      operational.purchases.push({ idempotencyKey, requestHash: sha256(JSON.stringify(input)), data: purchase });
      for (const item of purchaseItems) {
        const product = products.find(product => product.id === item.productId)!;
        const presentation = product.presentations.find(presentation => presentation.id === item.presentationId)!;
        counts(product, location).find(count => count.presentationId === (presentation.units === 1 ? null : presentation.id))!.quantity += item.quantity;
        movement(product, location, item.quantity * presentation.units, 'compra', purchase.number, createdAt);
      }
    }

    for (const [dayIndex, day] of availableDays.entries()) {
      const date = `${month}-${String(day).padStart(2, '0')}`;
      const cash: CashSession = {
        id: identifier('cash', date), openedAt: timestamp(date, 8), closedAt: timestamp(date, 18), openedBy: SYNTHETIC_DATA_LABEL,
        openingCents: 10000, expectedCents: 10000, countedCents: 10000, differenceCents: 0,
        payments: { efectivo: 0, yape: 0, plin: 0, transferencia: 0 }, movements: [],
      };
      let hasSales = false;
      for (const [locationIndex, location] of LOCATIONS.entries()) {
        const items: Sale['items'] = [];
        for (const plan of monthlyPlans) {
          for (const [index, presentation] of plan.product.presentations.entries()) {
            const quantity = plan.quantities[location][index][dayIndex];
            if (!quantity) continue;
            items.push({ productId: plan.product.id, presentationId: presentation.id, quantity, location,
              name: plan.product.name, presentationLabel: presentation.label, units: presentation.units * quantity,
              unitPriceCents: presentation.priceCents, totalCents: presentation.priceCents * quantity });
          }
        }
        if (!items.length) continue;
        const totalCents = items.reduce((total, item) => total + item.totalCents, 0);
        const paymentMethod = PAYMENT_METHODS[(monthIndex + dayIndex + locationIndex) % PAYMENT_METHODS.length];
        const paidCents = paymentMethod === 'efectivo' ? Math.ceil(totalCents / 1000) * 1000 : totalCents;
        const idempotencyKey = identifier('sale-request', `${date}/${location}`);
        const input: SaleInput = {
          idempotencyKey, documentType: 'ticket', customerId: null, paymentMethod, paidCents,
          items: items.map(({ productId, presentationId, quantity, location }) => ({ productId, presentationId, quantity, location })),
        };
        const createdAt = timestamp(date, 12, locationIndex * 15);
        const sale: Sale = {
          id: identifier('sale', `${date}/${location}`), number: `PR-${String(++saleNumber).padStart(6, '0')}`, documentType: 'ticket', status: 'PRUEBA',
          createdAt, userName: SYNTHETIC_DATA_LABEL, customer: null, paymentMethod, totalCents, paidCents,
          changeCents: paidCents - totalCents, items, cancelled: false,
        };
        operational.sales.push({ idempotencyKey, requestHash: sha256(JSON.stringify(input)), data: sale });
        hasSales = true;
        cash.payments[paymentMethod] += totalCents;
        if (paymentMethod === 'efectivo') cash.expectedCents += totalCents;
        for (const item of items) {
          const product = products.find(product => product.id === item.productId)!;
          const presentation = product.presentations.find(presentation => presentation.id === item.presentationId)!;
          counts(product, location).find(count => count.presentationId === (presentation.units === 1 ? null : presentation.id))!.quantity -= item.quantity;
          movement(product, location, -item.units, 'venta', sale.number, createdAt);
        }
      }
      if (hasSales) {
        cash.countedCents = cash.expectedCents;
        operational.cashSessions.push(cash);
      }
    }
  }

  return {
    manifest: {
      id: `synthetic-v1-${sha256(JSON.stringify([1, options.seed, options.asOfDate, options.months])).slice(0, 24)}`,
      kind: 'synthetic', label: SYNTHETIC_DATA_LABEL, version: 1, seed: options.seed, asOfDate: options.asOfDate,
      timeZone: 'America/Lima', historyStart, lastCompleteMonth: monthAt(currentOrdinal - 1), completeMonths: options.months,
      observedThrough: options.asOfDate, units: 'physical-items',
      coverage: products.map((product, index) => ({ productId: product.id, introducedOn: index === 5 ? introducedOn : historyStart,
        observedFrom: index === 5 ? introducedOn : historyStart, observedThrough: options.asOfDate, pattern: CATALOG[index].pattern })),
      counts: { products: products.length, sales: operational.sales.length, purchases: operational.purchases.length,
        stockMovements: operational.stockMovements.length, cashSessions: operational.cashSessions.length },
      dataSha256: syntheticOperationalHash(operational),
    },
    ...operational,
  };
}
