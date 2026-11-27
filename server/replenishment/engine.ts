import type { ForecastSeries } from '../../shared/forecast.js';
import type { BridgeDemand, PlanningQuantity, ReceiptDisposition, ReplenishmentInput, ReplenishmentItem, ReplenishmentMonth, ReplenishmentPlan, ScenarioReceipt } from '../../shared/replenishment.js';
import type { LocationId, Product } from '../../shared/types.js';
import { getPackagingStock } from '../../shared/stock-packaging.js';

const MAX_QUANTITY = 1_000_000_000;
const LOCATIONS: LocationId[] = ['puesto', 'almacen'];
class QuantityLimit extends Error {}

function quantity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_QUANTITY) throw new QuantityLimit('La cantidad o su equivalente físico supera el límite seguro de 1.000.000.000.');
  return value;
}

function physicalQuantity(value: number, units: number): number {
  quantity(value);
  quantity(value * units);
  return value;
}

function calendarDate(value: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  const result = shifted.toISOString().slice(0, 10);
  if (!calendarDate(result)) throw new Error('El plazo de recepción queda fuera del calendario admitido.');
  return result;
}

function monthOrdinal(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthAt(ordinal: number): string {
  return `${String(Math.floor(ordinal / 12)).padStart(4, '0')}-${String(ordinal % 12 + 1).padStart(2, '0')}`;
}

function key(productId: string, presentationId: string | null): string {
  return JSON.stringify([productId, presentationId]);
}

function canonicalPresentation(product: Product, presentationId: string | null): string | null {
  if (presentationId === null) {
    if (!product.presentations.some(presentation => presentation.units === 1)) throw new Error('El producto no tiene una presentación unitaria para esa entrada del escenario.');
    return null;
  }
  const presentation = product.presentations.find(presentation => presentation.id === presentationId);
  if (!presentation) throw new Error('La presentación del escenario no existe en el producto actual.');
  return presentation.units === 1 ? null : presentation.id;
}

function validReference(row: ScenarioReceipt | BridgeDemand) {
  if (typeof row.productId !== 'string' || !row.productId.trim() ||
      (row.presentationId !== null && (typeof row.presentationId !== 'string' || !row.presentationId.trim())) ||
      !LOCATIONS.includes(row.location)) throw new Error('La referencia de producto, presentación o ubicación del escenario no es válida.');
}

function validate(input: ReplenishmentInput) {
  const { scenario } = input;
  if (!calendarDate(input.asOfDate)) throw new Error('La fecha actual debe ser una fecha válida YYYY-MM-DD en America/Lima.');
  if (!Number.isInteger(scenario.horizon) || scenario.horizon < 1 || scenario.horizon > 12) throw new Error('El horizonte debe estar entre 1 y 12 meses.');
  if (!Number.isInteger(scenario.leadTimeDays) || scenario.leadTimeDays < 0 || scenario.leadTimeDays > 365) throw new Error('El plazo debe ser un entero entre 0 y 365 días.');
  if (!Number.isFinite(scenario.reservePercent) || scenario.reservePercent < 0 || scenario.reservePercent > 100 ||
      Math.abs(scenario.reservePercent * 100 - Math.round(scenario.reservePercent * 100)) > 0.000001) throw new Error('La reserva debe estar entre 0 y 100, con hasta dos decimales.');
  if (scenario.productId !== undefined && (typeof scenario.productId !== 'string' || !scenario.productId.trim())) throw new Error('El filtro de producto no es válido.');
  if (!Array.isArray(scenario.receipts) || scenario.receipts.length > 100 || !Array.isArray(scenario.bridgeDemand) || scenario.bridgeDemand.length > 200) throw new Error('El escenario admite hasta 100 entradas y 200 consumos de enlace.');
  if (monthOrdinal(input.asOfDate) + scenario.horizon > 9999 * 12 + 11) throw new Error('El horizonte queda fuera del calendario admitido.');
  const receiptIds = new Set<string>();
  const productMap = new Map(input.products.map(product => [product.id, product]));
  for (const row of scenario.receipts) {
    validReference(row);
    if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > 100 || receiptIds.has(row.id.trim())) throw new Error('Cada entrada necesita un identificador único de hasta 100 caracteres.');
    receiptIds.add(row.id.trim());
    if (!calendarDate(row.expectedOn) || !['pending', 'received', 'cancelled'].includes(row.status)) throw new Error('La fecha o el estado de la entrada no es válido.');
    if (!Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > MAX_QUANTITY) throw new Error('La cantidad de una entrada debe ser un entero entre 1 y 1.000.000.000.');
    const product = productMap.get(row.productId);
    if (product?.active && (!scenario.productId || product.id === scenario.productId)) canonicalPresentation(product, row.presentationId);
  }
  const bridgeKeys = new Set<string>();
  for (const row of scenario.bridgeDemand) {
    validReference(row);
    if (!Number.isSafeInteger(row.quantity) || row.quantity < 0 || row.quantity > MAX_QUANTITY) throw new Error('El consumo de enlace debe ser un entero entre 0 y 1.000.000.000.');
    const product = productMap.get(row.productId);
    if (!product?.active) throw new Error('El producto del consumo de enlace no está activo o no existe.');
    const id = JSON.stringify([product.id, canonicalPresentation(product, row.presentationId), row.location]);
    if (bridgeKeys.has(id)) throw new Error('No repitas un consumo de enlace del mismo saldo físico y ubicación.');
    bridgeKeys.add(id);
  }
  for (const location of LOCATIONS) {
    const report = input.forecasts[location];
    if (!report || report.query.cutoff !== input.asOfDate || report.query.location !== location || report.query.horizon < scenario.horizon || report.unit !== 'physical-items' || report.timeZone !== 'America/Lima') {
      throw new Error('Los pronósticos deben corresponder al corte actual, ubicación y horizonte del escenario.');
    }
  }
  const puestoSource = input.forecasts.puesto.source;
  const warehouseSource = input.forecasts.almacen.source;
  if (puestoSource.kind !== warehouseSource.kind || puestoSource.datasetId !== warehouseSource.datasetId ||
      (input.manifest && puestoSource.datasetId !== input.manifest.id)) throw new Error('Los pronósticos no corresponden al mismo origen de datos.');
}

interface Bin {
  presentationId: string | null;
  label: string;
  units: number;
  sourceIds: string[];
}

function bins(product: Product): Bin[] {
  const result: Bin[] = product.presentations.filter(presentation => presentation.units !== 1).map(presentation => ({
    presentationId: presentation.id, label: presentation.label, units: presentation.units, sourceIds: [presentation.id],
  }));
  const units = product.presentations.filter(presentation => presentation.units === 1);
  if (units.length) result.push({ presentationId: null, label: 'Unidades sueltas', units: 1, sourceIds: units.map(presentation => presentation.id) });
  return result;
}

function unique(messages: string[]): string[] { return [...new Set(messages)]; }

function projectMonth(opening: PlanningQuantity, receipts: PlanningQuantity, physical: PlanningQuantity, units: number,
  month: string, asOfDate: string, reservePercent: number, leadTimeDays: number): ReplenishmentMonth {
  const bounded = (value: number) => physicalQuantity(value, units);
  const needBy = `${month}-01`;
  const available = { puesto: bounded(opening.puesto + receipts.puesto), almacen: bounded(opening.almacen + receipts.almacen) };
  const demand = { puesto: bounded(Math.ceil(physical.puesto / units)), almacen: bounded(Math.ceil(physical.almacen / units)) };
  const reserve = { puesto: bounded(Math.ceil(demand.puesto * reservePercent / 100)), almacen: bounded(Math.ceil(demand.almacen * reservePercent / 100)) };
  const target = { puesto: bounded(demand.puesto + reserve.puesto), almacen: bounded(demand.almacen + reserve.almacen) };
  const transferFromWarehouse = Math.min(Math.max(0, available.almacen - target.almacen), Math.max(0, target.puesto - available.puesto));
  const afterTransfer = { puesto: bounded(available.puesto + transferFromWarehouse), almacen: bounded(available.almacen - transferFromWarehouse) };
  const suggestedPurchase = { puesto: bounded(Math.max(0, target.puesto - afterTransfer.puesto)), almacen: bounded(Math.max(0, target.almacen - afterTransfer.almacen)) };
  const earliestArrivalIfOrderedToday = shiftDate(asOfDate, leadTimeDays);
  const timingRisk = (suggestedPurchase.puesto > 0 || suggestedPurchase.almacen > 0) && earliestArrivalIfOrderedToday > needBy;
  const warnings = timingRisk ? [`La recepción más temprana sería el ${earliestArrivalIfOrderedToday}, después de la necesidad conservadora del ${needBy}. El saldo condicionado supone una recepción a tiempo y requiere ajustar el escenario.`] : [];
  return {
    month, needBy, orderBy: shiftDate(needBy, -leadTimeDays), earliestArrivalIfOrderedToday,
    opening: { ...opening }, receipts: { ...receipts }, available, demandPhysicalUnits: physical, demand, reserve, transferFromWarehouse, suggestedPurchase,
    closingWithoutThisPurchase: { puesto: Math.max(0, afterTransfer.puesto - demand.puesto), almacen: Math.max(0, afterTransfer.almacen - demand.almacen) },
    uncoveredDemand: { puesto: Math.max(0, demand.puesto - afterTransfer.puesto), almacen: Math.max(0, demand.almacen - afterTransfer.almacen) },
    closingIfRecommendations: { puesto: bounded(afterTransfer.puesto + suggestedPurchase.puesto - demand.puesto), almacen: bounded(afterTransfer.almacen + suggestedPurchase.almacen - demand.almacen) },
    timingRisk, warnings,
  };
}

/** Suggest hypothetical stock actions without creating orders or changing inventory. */
export function buildReplenishment(input: ReplenishmentInput): ReplenishmentPlan {
  validate(input);
  const scenario = structuredClone(input.scenario);
  scenario.reservePercent = Math.round(scenario.reservePercent * 100) / 100;
  const months = Array.from({ length: scenario.horizon }, (_, index) => monthAt(monthOrdinal(input.asOfDate) + index + 1));
  const products = input.products.filter(product => product.active && (!scenario.productId || product.id === scenario.productId));
  const productsById = new Map(products.map(product => [product.id, product]));
  const scheduled = new Map<string, ScenarioReceipt[]>();
  const receiptWarnings = new Map<string, string[]>();
  const receiptDispositions: ReceiptDisposition[] = scenario.receipts.map(receipt => {
    const product = productsById.get(receipt.productId);
    if (!product) return { id: receipt.id, status: 'outside-filter', eligibleMonth: null, note: 'El producto no forma parte de los productos activos seleccionados.' };
    if (receipt.status === 'received') return { id: receipt.id, status: 'received-excluded', eligibleMonth: null, note: 'La entrada recibida ya debe estar incluida en el inventario actual y no se suma otra vez.' };
    if (receipt.status === 'cancelled') return { id: receipt.id, status: 'cancelled-excluded', eligibleMonth: null, note: 'La entrada cancelada no incrementa el saldo proyectado.' };
    if (receipt.expectedOn <= input.asOfDate) return { id: receipt.id, status: 'overdue-excluded', eligibleMonth: null, note: 'La fecha pendiente ya venció o corresponde al corte. Confirma su recepción antes de incluirla.' };
    const eligibleMonth = months.find(month => receipt.expectedOn <= `${month}-01`);
    if (!eligibleMonth) return { id: receipt.id, status: 'outside-horizon', eligibleMonth: null, note: 'La entrada llega después del último inicio de mes planificado y queda fuera del horizonte.' };
    const presentationId = canonicalPresentation(product, receipt.presentationId);
    const receiptKey = key(product.id, presentationId);
    scheduled.set(receiptKey, [...(scheduled.get(receiptKey) ?? []), receipt]);
    let note = `Se incluye una vez en ${eligibleMonth}, antes de su necesidad al día 1.`;
    if (receipt.expectedOn.slice(0, 7) >= months[0] && !receipt.expectedOn.endsWith('-01')) {
      note = `Llega después del día 1 de ${receipt.expectedOn.slice(0, 7)} y se incluye desde ${eligibleMonth}.`;
      receiptWarnings.set(receiptKey, [...(receiptWarnings.get(receiptKey) ?? []), note]);
    }
    return { id: receipt.id, status: 'scheduled', eligibleMonth, note };
  });
  const dispositionById = new Map(receiptDispositions.map(disposition => [disposition.id, disposition]));
  const warnings = unique([...input.forecasts.puesto.warnings, ...input.forecasts.almacen.warnings]);
  if (scenario.bridgeDemand.some(row => !productsById.has(row.productId))) warnings.push('Hay consumos de enlace fuera del filtro de producto que no se aplicaron a este plan.');
  if (scenario.productId && !products.length) warnings.push('No hay un producto activo que coincida con el filtro.');
  const items: ReplenishmentItem[] = [];

  for (const product of products) {
    const packaging = { puesto: getPackagingStock(product, 'puesto'), almacen: getPackagingStock(product, 'almacen') };
    for (const bin of bins(product)) {
      const binKey = key(product.id, bin.presentationId);
      const initialStock = {
        puesto: packaging.puesto?.find(row => row.presentationId === bin.presentationId)?.quantity ?? null,
        almacen: packaging.almacen?.find(row => row.presentationId === bin.presentationId)?.quantity ?? null,
      };
      const bridgeDemand = { puesto: 0, almacen: 0 };
      for (const row of scenario.bridgeDemand) {
        if (row.productId === product.id && canonicalPresentation(product, row.presentationId) === bin.presentationId) bridgeDemand[row.location] = row.quantity;
      }
      const afterBridge = {
        puesto: initialStock.puesto === null ? null : Math.max(0, initialStock.puesto - bridgeDemand.puesto),
        almacen: initialStock.almacen === null ? null : Math.max(0, initialStock.almacen - bridgeDemand.almacen),
      };
      const bridgeUncovered = {
        puesto: initialStock.puesto === null ? null : Math.max(0, bridgeDemand.puesto - initialStock.puesto),
        almacen: initialStock.almacen === null ? null : Math.max(0, bridgeDemand.almacen - initialStock.almacen),
      };
      const sources: Record<LocationId, ForecastSeries[]> = { puesto: [], almacen: [] };
      for (const location of LOCATIONS) sources[location] = input.forecasts[location].series.filter(row => row.productId === product.id && bin.sourceIds.includes(row.presentationId));
      const itemWarnings = unique([...sources.puesto.flatMap(row => row.warnings), ...sources.almacen.flatMap(row => row.warnings), ...(receiptWarnings.get(binKey) ?? [])]);
      const item: ReplenishmentItem = {
        id: binKey, productId: product.id, productName: product.name, sku: product.sku, presentationId: bin.presentationId,
        presentationLabel: bin.label, sourcePresentationIds: [...bin.sourceIds], unitsPerPresentation: bin.units,
        quantityUnit: bin.presentationId === null ? 'loose-pieces' : 'closed-packages', status: 'ready',
        initialStock, bridgeDemand, bridgeUncovered, afterBridge, months: [], warnings: itemWarnings,
      };
      if (bridgeUncovered.puesto || bridgeUncovered.almacen) item.warnings.push('El consumo de enlace excede existencias en alguna ubicación. El faltante se muestra aparte y no se arrastra como mercadería.');
      if (initialStock.puesto === null || initialStock.almacen === null) {
        item.status = 'unknown-stock';
        item.warnings.push('Falta un conteo físico coherente en puesto o almacén. Se bloquea la planificación de este saldo.');
      } else if (LOCATIONS.some(location => bin.sourceIds.some(id => sources[location].filter(row => row.presentationId === id).length !== 1) || sources[location].some(row => row.status !== 'ready' ||
          row.unitsPerPresentation !== bin.units || months.some(month => row.forecast.filter(point => point.month === month).length !== 1)))) {
        item.status = 'insufficient-history';
        item.warnings.push('Falta un pronóstico mensual listo y coherente para alguna presentación o ubicación.');
      } else {
        try {
          quantity(bin.units);
          if (bin.units < 1) throw new QuantityLimit('La presentación debe contener piezas enteras positivas.');
          for (const location of LOCATIONS) physicalQuantity(bridgeDemand[location], bin.units);
          let opening = { puesto: physicalQuantity(afterBridge.puesto!, bin.units), almacen: physicalQuantity(afterBridge.almacen!, bin.units) };
          for (const month of months) {
            const physical = { puesto: 0, almacen: 0 };
            const receipts = { puesto: 0, almacen: 0 };
            for (const location of LOCATIONS) {
              for (const source of sources[location]) physical[location] = quantity(physical[location] + quantity(source.forecast.find(point => point.month === month)!.physicalUnits));
            }
            for (const receipt of scheduled.get(binKey) ?? []) {
              if (dispositionById.get(receipt.id)!.eligibleMonth === month) receipts[receipt.location] = quantity(receipts[receipt.location] + receipt.quantity);
            }
            const projected = projectMonth(opening, receipts, physical, bin.units, month, input.asOfDate, scenario.reservePercent, scenario.leadTimeDays);
            item.months.push(projected);
            opening = projected.closingIfRecommendations;
          }
        } catch (error) {
          if (!(error instanceof QuantityLimit)) throw error;
          item.status = 'quantity-limit';
          item.months = [];
          item.warnings.push(error.message);
        }
      }
      item.warnings = unique(item.warnings);
      items.push(item);
    }
  }
  return {
    version: 1, asOfDate: input.asOfDate, firstMonth: months[0], timeZone: 'America/Lima', scenario,
    source: { ...input.forecasts.puesto.source },
    assumptions: [
      'El inventario inicial es el saldo actual al corte. El consumo de enlace explícito se descuenta antes del horizonte; su valor cero omite el consumo restante del mes parcial.',
      'Toda la demanda mensual y su reserva se consideran necesarias el día 1 como criterio conservador. No se determina una fecha diaria garantizada de quiebre de stock.',
      'La reserva es el porcentaje indicado sobre la demanda mensual, redondeado hacia arriba por saldo físico y ubicación.',
      'Cada empaque cerrado mantiene su saldo. Las presentaciones unitarias comparten una sola cuenta de piezas sueltas. No se abren empaques automáticamente.',
      'El límite numérico se verifica por saldo físico individual. La suma de piezas de todas las presentaciones del producto se vuelve a validar al registrar la operación real.',
      'Las compras registradas ya están incluidas en el inventario. Solo las entradas futuras pendientes explícitas del escenario se añaden una vez.',
      'Los saldos finales y las aperturas posteriores son condicionales a ejecutar las recomendaciones y recibirlas a tiempo. El plan no crea pedidos, traslados ni operaciones reales.',
    ],
    receiptDispositions, warnings: unique(warnings), items,
  };
}
