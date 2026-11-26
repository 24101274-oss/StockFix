import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Product } from '../../shared/types';
import type { ReplenishmentReport, ReplenishmentScenario } from '../../shared/replenishment';
import type { ForecastDependencies } from '../forecast/routes';
import { buildForecast } from '../forecast/engine';
import { csvBuffer, limaDate, workbookBuffer } from '../reports';
import { buildReplenishment } from './engine';

export type ReplenishmentDependencies = ForecastDependencies;

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const identifier = z.string().trim().min(1).max(120);
const location = z.enum(['puesto', 'almacen']);
const calendarDate = z.string().refine(isCalendarDate, 'La fecha de recepción debe existir y usar AAAA-MM-DD.');
const presentationId = identifier.nullable();
const receiptSchema = z.object({
  id: z.string().trim().min(1).max(100), productId: identifier, presentationId,
  location, quantity: z.number().int().min(1).max(1_000_000_000),
  expectedOn: calendarDate, status: z.enum(['pending', 'received', 'cancelled']),
}).strict();
const bridgeSchema = z.object({
  productId: identifier, presentationId, location, quantity: z.number().int().min(0).max(1_000_000_000),
}).strict();
const scenarioSchema = z.object({
  horizon: z.number().int().min(1).max(12).default(3),
  leadTimeDays: z.number().int().min(0).max(365).default(14),
  reservePercent: z.number().min(0).max(100)
    .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, 'La reserva admite como máximo dos decimales.')
    .transform(value => Math.round(value * 100) / 100).default(10),
  productId: identifier.optional(), receipts: z.array(receiptSchema).max(100).default([]), bridgeDemand: z.array(bridgeSchema).max(200).default([]),
}).strict().superRefine((scenario, context) => {
  const ids = new Set<string>();
  scenario.receipts.forEach((receipt, index) => {
    if (ids.has(receipt.id)) context.addIssue({ code: 'custom', path: ['receipts', index, 'id'], message: 'Cada entrada declarada necesita un ID único.' });
    ids.add(receipt.id);
  });
});
const noQuery = z.object({}).strict();
const exportQuery = z.object({ format: z.enum(['csv', 'xlsx']).default('xlsx') }).strict();
const exportBody = z.object({ scenario: scenarioSchema, snapshot: z.string().regex(/^[a-f\d]{64}$/i, 'La huella del plan no es válida.').transform(value => value.toLowerCase()) }).strict();

function fail(message: string, statusCode: number): never { throw Object.assign(new Error(message), { statusCode }); }

function validateReferences(products: Product[], scenario: ReplenishmentScenario) {
  const active = new Map(products.filter(product => product.active).map(product => [product.id, product]));
  function productFor(id: string) {
    const product = active.get(id);
    if (!product) fail('Producto activo no encontrado.', 404);
    return product;
  }
  function canonicalPresentation(product: Product, id: string | null): string | null {
    if (id === null) {
      if (!product.presentations.some(presentation => presentation.units === 1)) fail('El producto no tiene una presentación unitaria para las unidades sueltas declaradas.', 400);
      return null;
    }
    const presentation = product.presentations.find(item => item.id === id);
    if (!presentation) fail('La presentación no pertenece al producto actual.', 400);
    return presentation.units === 1 ? null : presentation.id;
  }
  if (scenario.productId) productFor(scenario.productId);
  for (const receipt of scenario.receipts) canonicalPresentation(productFor(receipt.productId), receipt.presentationId);
  const bridgeKeys = new Set<string>();
  for (const bridge of scenario.bridgeDemand) {
    const canonical = canonicalPresentation(productFor(bridge.productId), bridge.presentationId);
    const key = JSON.stringify([bridge.productId, canonical, bridge.location]);
    if (bridgeKeys.has(key)) fail('El consumo puente repite una misma presentación física y ubicación, incluidas las unidades sueltas.', 400);
    bridgeKeys.add(key);
  }
}

type ExportTable = Parameters<typeof csvBuffer>[0];
type Cell = ExportTable['rows'][number][number];

function planTables(report: ReplenishmentReport): ExportTable[] {
  const columns = [
    ['origin', 'Origen'], ['sourceLabel', 'Etiqueta de origen'], ['dataset', 'Dataset'], ['asOfDate', 'Fecha del plan (Lima)'],
    ['firstMonth', 'Primer mes proyectado'], ['horizon', 'Horizonte (meses)'], ['lead', 'Plazo (días)'], ['reserve', 'Reserva (%)'], ['snapshot', 'Huella del plan'],
    ['product', 'Producto'], ['sku', 'SKU'], ['productId', 'ID producto'], ['presentationId', 'ID presentación (vacío = sueltas)'],
    ['presentation', 'Presentación física'], ['units', 'Piezas por presentación'], ['quantityUnit', 'Unidad de cantidad'], ['status', 'Estado'],
    ['location', 'Ubicación'], ['rowType', 'Tipo de fila'], ['month', 'Mes'], ['needBy', 'Se necesita el'], ['orderBy', 'Pedir a más tardar'], ['earliestArrival', 'Llegada si se pide hoy'],
    ['initialStock', 'Stock inicial real'], ['bridge', 'Consumo puente declarado'], ['bridgeUncovered', 'Puente sin cubrir'], ['afterBridge', 'Stock tras puente'],
    ['opening', 'Apertura proyectada'], ['receipts', 'Entradas elegibles'], ['available', 'Disponible antes del traslado'],
    ['physicalDemand', 'Demanda (piezas)'], ['demand', 'Demanda (presentaciones físicas)'], ['reserveQuantity', 'Reserva (presentaciones físicas)'],
    ['transfer', 'Traslado (+entrada/-salida)'], ['purchase', 'Compra sugerida'], ['withoutPurchase', 'Cierre sin esta compra'],
    ['uncovered', 'Demanda sin cubrir'], ['conditionalClosing', 'Cierre si se siguen recomendaciones'], ['timingRisk', 'Riesgo de plazo'],
    ['receiptId', 'ID entrada declarada'], ['receiptDate', 'Fecha entrada declarada'], ['receiptQuantity', 'Cantidad entrada declarada'],
    ['receiptStatus', 'Estado entrada declarada'], ['receiptDisposition', 'Tratamiento de entrada'], ['eligibleMonth', 'Mes elegible de entrada'], ['warnings', 'Advertencias'],
  ] as const;
  type Key = typeof columns[number][0];
  const common: Partial<Record<Key, Cell>> = {
    origin: report.source.kind, sourceLabel: report.source.label, dataset: report.source.datasetId,
    asOfDate: report.asOfDate, firstMonth: report.firstMonth, horizon: report.scenario.horizon,
    lead: report.scenario.leadTimeDays, reserve: report.scenario.reservePercent, snapshot: report.snapshot,
  };
  const row = (values: Partial<Record<Key, Cell>>) => columns.map(([key]) => ({ ...common, ...values })[key] ?? null);
  const rows = [row({ rowType: 'Metadatos del plan', warnings: report.warnings.join(' | ') })];
  for (const item of report.items) {
    const identity: Partial<Record<Key, Cell>> = {
      product: item.productName, sku: item.sku, productId: item.productId, presentationId: item.presentationId,
      presentation: item.presentationLabel, units: item.unitsPerPresentation, quantityUnit: item.quantityUnit, status: item.status,
    };
    for (const location of ['puesto', 'almacen'] as const) {
      rows.push(row({ ...identity, location, rowType: 'Base y consumo puente', month: report.asOfDate.slice(0, 7),
        initialStock: item.initialStock[location], bridge: item.bridgeDemand[location], bridgeUncovered: item.bridgeUncovered[location], afterBridge: item.afterBridge[location],
        warnings: [...report.warnings, ...item.warnings].join(' | '),
      }));
      for (const month of item.months) rows.push(row({
        ...identity, location, rowType: 'Proyección mensual condicional', month: month.month, needBy: month.needBy, orderBy: month.orderBy, earliestArrival: month.earliestArrivalIfOrderedToday,
        opening: month.opening[location], receipts: month.receipts[location], available: month.available[location], physicalDemand: month.demandPhysicalUnits[location], demand: month.demand[location],
        reserveQuantity: month.reserve[location], transfer: location === 'puesto' ? month.transferFromWarehouse : -month.transferFromWarehouse,
        purchase: month.suggestedPurchase[location], withoutPurchase: month.closingWithoutThisPurchase[location], uncovered: month.uncoveredDemand[location],
        conditionalClosing: month.closingIfRecommendations[location], timingRisk: month.timingRisk ? 'Sí' : 'No', warnings: [...report.warnings, ...item.warnings, ...month.warnings].join(' | '),
      }));
    }
  }
  const receipts = report.scenario.receipts.map(receipt => {
    const disposition = report.receiptDispositions.find(item => item.id === receipt.id);
    return { receipt, disposition };
  });
  for (const { receipt, disposition } of receipts) rows.push(row({
    productId: receipt.productId, presentationId: receipt.presentationId, location: receipt.location, rowType: 'Entrada declarada del escenario',
    receiptId: receipt.id, receiptDate: receipt.expectedOn, receiptQuantity: receipt.quantity, receiptStatus: receipt.status,
    receiptDisposition: disposition?.status ?? null, eligibleMonth: disposition?.eligibleMonth ?? null, warnings: disposition?.note ?? null,
  }));
  return [
    { name: 'Plan mensual', columns: columns.map(([, title]) => ({ title, width: title === 'Advertencias' ? 90 : title.includes('ID') ? 40 : 27 })), rows },
    { name: 'Entradas declaradas', columns: ['ID entrada', 'ID producto', 'ID presentación (vacío = sueltas)', 'Ubicación', 'Cantidad declarada', 'Fecha esperada', 'Estado declarado', 'Tratamiento', 'Mes elegible', 'Explicación'].map(title => ({ title, width: 32 })),
      rows: receipts.map(({ receipt, disposition }) => [receipt.id, receipt.productId, receipt.presentationId, receipt.location, receipt.quantity, receipt.expectedOn, receipt.status, disposition?.status ?? null, disposition?.eligibleMonth ?? null, disposition?.note ?? null]),
    },
    { name: 'Supuestos', columns: [{ title: 'Campo', width: 36 }, { title: 'Valor', width: 110 }], rows: [
      ['Origen', report.source.label], ['Dataset', report.source.datasetId], ['Fecha del plan (Lima)', report.asOfDate], ['Zona horaria', report.timeZone],
      ['Huella del plan', report.snapshot], ['Horizonte (meses)', report.scenario.horizon], ['Plazo (días)', report.scenario.leadTimeDays], ['Reserva (%)', report.scenario.reservePercent],
      ['Unidades', 'Paquetes cerrados y piezas sueltas son categorías físicas distintas; un conteo desconocido queda vacío.'],
      ['Traslado', 'Cantidad positiva entra al puesto; la misma cantidad negativa sale del almacén. No sumar ambos lados como compras.'],
      ['Condición', 'Los cierres y aperturas futuros suponen que se siguen las recomendaciones; no son movimientos ejecutados.'],
      ...report.assumptions.map((assumption, index): [string, string] => [`Supuesto ${index + 1}`, assumption]), ['Advertencias', report.warnings.join(' | ')],
    ] },
  ];
}

export function registerReplenishment(app: FastifyInstance, dependencies: ReplenishmentDependencies) {
  async function preview(scenario: ReplenishmentScenario): Promise<ReplenishmentReport> {
    const asOfDate = limaDate(dependencies.now?.() ?? new Date());
    const [year, month] = asOfDate.split('-').map(Number);
    if (year * 12 + month - 1 + scenario.horizon > 9999 * 12 + 11) fail('El horizonte no puede superar diciembre del año 9999.', 400);
    const earliestArrival = new Date(`${asOfDate}T12:00:00.000Z`);
    earliestArrival.setUTCDate(earliestArrival.getUTCDate() + scenario.leadTimeDays);
    const nextMonth = month === 12 ? `${String(year + 1).padStart(4, '0')}-01` : `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`;
    const earliestOrder = new Date(`${nextMonth}-01T12:00:00.000Z`);
    earliestOrder.setUTCDate(earliestOrder.getUTCDate() - scenario.leadTimeDays);
    if (!isCalendarDate(earliestArrival.toISOString().slice(0, 10)) || !isCalendarDate(earliestOrder.toISOString().slice(0, 10))) fail('El plazo queda fuera del calendario admitido.', 400);
    const [products, sales, manifest] = await Promise.all([dependencies.loadProducts(), dependencies.loadSales(), dependencies.loadManifest()]);
    validateReferences(products, scenario);
    const query = { cutoff: asOfDate, horizon: scenario.horizon, ...(scenario.productId ? { productId: scenario.productId } : {}) };
    const forecasts = {
      puesto: buildForecast({ products, sales, manifest, query: { ...query, location: 'puesto' } }),
      almacen: buildForecast({ products, sales, manifest, query: { ...query, location: 'almacen' } }),
    };
    const plan = buildReplenishment({ asOfDate, products, forecasts, manifest, scenario });
    return { ...plan, snapshot: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
  }
  app.post('/api/replenishment/preview', async (request, reply) => {
    await dependencies.requireAdmin(request);
    noQuery.parse(request.query);
    const result = await preview(scenarioSchema.parse(request.body));
    return reply.header('X-StockFix-Data-Origin', result.source.kind).header('X-StockFix-Plan-Date', result.asOfDate).send(result);
  });
  app.post('/api/replenishment/export', async (request, reply) => {
    await dependencies.requireAdmin(request);
    const { format } = exportQuery.parse(request.query);
    const { scenario, snapshot } = exportBody.parse(request.body);
    const result = await preview(scenario);
    if (snapshot !== result.snapshot) fail('Los datos cambiaron; vuelve a calcular el plan antes de exportarlo.', 409);
    const tables = planTables(result);
    const buffer = format === 'csv' ? csvBuffer(tables[0]) : await workbookBuffer(tables);
    return reply.header('Content-Disposition', `attachment; filename="stockfix-reposicion-${result.asOfDate}-PRUEBA.${format}"`)
      .header('X-StockFix-Data-Origin', result.source.kind).header('X-StockFix-Plan-Date', result.asOfDate).header('X-StockFix-Plan-Snapshot', result.snapshot)
      .type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
  });
}
