import type { ForecastCandidate, ForecastEvaluation, ForecastHistoryPoint, ForecastInput, ForecastMethod, ForecastReport, ForecastSeries } from '../../shared/forecast';
import type { Product } from '../../shared/types';
import { limaDate } from '../reports';

const STOCK_WARNING = 'Las ventas registradas pueden estar limitadas por faltantes de stock. El pronóstico describe ventas observadas y requiere revisar disponibilidad.';
const RECORDING_WARNING = 'Se infiere la cobertura desde la primera venta y se supone un registro continuo posterior. Los meses sin ventas se consideran cero dentro de ese intervalo.';
const METHODS: ForecastMethod[] = ['last-month', 'moving-average-3', 'linear-trend'];

function calendarDate(value: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function ordinal(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthAt(value: number): string {
  return `${String(Math.floor(value / 12)).padStart(4, '0')}-${String(value % 12 + 1).padStart(2, '0')}`;
}

function lastDay(date: string): boolean {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.getUTCDate() === 1;
}

interface Observations {
  months: Map<string, number>;
  firstDate: string | null;
  invalidLines: number;
  changedSize: boolean;
}

interface Coverage {
  from: string;
  through: string;
}

function seriesKey(productId: string, presentationId: string): string {
  return JSON.stringify([productId, presentationId]);
}

function prediction(method: ForecastMethod, values: number[], step: number): number {
  let estimate: number;
  if (method === 'last-month') estimate = values[values.length - 1];
  else if (method === 'moving-average-3') estimate = values.slice(-3).reduce((sum, value) => sum + value, 0) / 3;
  else if (method === 'seasonal-naive') estimate = values[values.length - 12 + (step - 1) % 12];
  else {
    const meanX = (values.length - 1) / 2;
    const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
    const numerator = values.reduce((sum, value, index) => sum + (index - meanX) * value, 0);
    const denominator = values.length * (values.length * values.length - 1) / 12;
    const slope = numerator / denominator;
    estimate = meanY + slope * (values.length - 1 + step - meanX);
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(estimate)));
}

function evaluate(history: ForecastHistoryPoint[]): { method: ForecastMethod; evaluation: ForecastEvaluation } {
  const values = history.map(point => point.physicalUnits);
  const methods = history.length >= 15 ? [...METHODS, 'seasonal-naive' as const] : METHODS;
  const candidates: ForecastCandidate[] = methods.map(method => {
    const errors = values.slice(-3).map((observed, index) => {
      const training = values.slice(0, values.length - 3 + index);
      return prediction(method, training, 1) - observed;
    });
    return { method, mae: errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length,
      bias: errors.reduce((sum, error) => sum + error, 0) / errors.length };
  });
  const best = candidates.reduce((selected, candidate) => candidate.mae < selected.mae ? candidate : selected);
  return {
    method: best.method,
    evaluation: { kind: 'rolling-one-step', months: history.slice(-3).map(point => point.month), folds: 3,
      mae: best.mae, bias: best.bias, baselineMae: candidates[0].mae, candidates },
  };
}

function coverageFor(input: ForecastInput, product: Product, observations: Observations): Coverage | null {
  if (!input.manifest) return observations.firstDate ? { from: observations.firstDate, through: input.query.cutoff } : null;
  const coverage = input.manifest.coverage.find(row => row.productId === product.id);
  if (!coverage) return null;
  const dates = [coverage.introducedOn, coverage.observedFrom, coverage.observedThrough, input.manifest.historyStart, input.manifest.observedThrough];
  if (!dates.every(calendarDate)) return null;
  const from = [coverage.introducedOn, coverage.observedFrom, input.manifest.historyStart].sort().at(-1)!;
  const through = [coverage.observedThrough, input.manifest.observedThrough, input.query.cutoff].sort()[0];
  return from <= through ? { from, through } : null;
}

function completeHistory(coverage: Coverage | null, observations: Observations, cutoffMonth: number): ForecastHistoryPoint[] {
  if (!coverage) return [];
  const first = ordinal(coverage.from) + (coverage.from.endsWith('-01') ? 0 : 1);
  const last = Math.min(ordinal(coverage.through) - (lastDay(coverage.through) ? 0 : 1), cutoffMonth - 1);
  const history: ForecastHistoryPoint[] = [];
  for (let month = Math.max(first, last - 59); month <= last; month++) {
    const key = monthAt(month);
    history.push({ month: key, physicalUnits: observations.months.get(key) ?? 0 });
  }
  return history;
}

/** A read-only monthly forecast. SaleItem.units already contains physical pieces. */
export function buildForecast(input: ForecastInput): ForecastReport {
  const { query } = input;
  if (!calendarDate(query.cutoff)) throw new Error('La fecha de corte debe ser una fecha válida YYYY-MM-DD en America/Lima.');
  if (!Number.isInteger(query.horizon) || query.horizon < 1 || query.horizon > 12) throw new Error('El horizonte debe ser un entero entre 1 y 12 meses.');
  if (!['all', 'puesto', 'almacen'].includes(query.location)) throw new Error('La ubicación del pronóstico no es válida.');
  const cutoffMonth = ordinal(query.cutoff);
  if (cutoffMonth + query.horizon > 9999 * 12 + 11) throw new Error('El horizonte excede el año 9999.');
  const products = input.products.filter(product => product.active && (!query.productId || product.id === query.productId));
  const byProduct = new Map(products.map(product => [product.id, product]));
  const observations = new Map<string, Observations>();
  const removedPresentations = new Set<string>();
  const reportWarnings = [STOCK_WARNING];
  let invalidSales = 0;
  for (const product of products) {
    for (const presentation of product.presentations) {
      observations.set(seriesKey(product.id, presentation.id), { months: new Map(), firstDate: null, invalidLines: 0, changedSize: false });
    }
  }

  for (const sale of input.sales) {
    if (sale.cancelled) continue;
    const timestamp = new Date(sale.createdAt);
    if (typeof sale.createdAt !== 'string' || !calendarDate(sale.createdAt.slice(0, 10)) ||
        !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(sale.createdAt) || !Number.isFinite(timestamp.getTime()) || !Array.isArray(sale.items)) {
      invalidSales++;
      continue;
    }
    const date = limaDate(timestamp);
    if (date > query.cutoff) continue;
    for (const item of sale.items) {
      if (!item || typeof item !== 'object') { invalidSales++; continue; }
      const product = byProduct.get(item.productId);
      if (!product) continue;
      if (query.location !== 'all' && item.location !== query.location) continue;
      const entry = observations.get(seriesKey(product.id, item.presentationId));
      if (!entry) { removedPresentations.add(product.id); continue; }
      if (!['puesto', 'almacen'].includes(item.location) || !Number.isSafeInteger(item.units) || item.units <= 0 ||
          !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !Number.isSafeInteger(item.units / item.quantity)) {
        entry.invalidLines++;
        continue;
      }
      const presentation = product.presentations.find(presentation => presentation.id === item.presentationId)!;
      if (item.units / item.quantity !== presentation.units) entry.changedSize = true;
      const month = date.slice(0, 7);
      const total = (entry.months.get(month) ?? 0) + item.units;
      if (!Number.isSafeInteger(total)) { entry.invalidLines++; continue; }
      entry.months.set(month, total);
      if (!entry.firstDate || date < entry.firstDate) entry.firstDate = date;
    }
  }

  if (invalidSales) reportWarnings.push(`Se omitieron ${invalidSales} ventas con fecha o detalle inválido.`);
  if (!input.manifest) reportWarnings.push(RECORDING_WARNING);
  if (query.productId && !products.length) reportWarnings.push('No se encontró un producto activo con el identificador solicitado.');
  const series: ForecastSeries[] = [];
  for (const product of products) {
    for (const presentation of product.presentations) {
      const entry = observations.get(seriesKey(product.id, presentation.id))!;
      const coverage = coverageFor(input, product, entry);
      const history = completeHistory(coverage, entry, cutoffMonth);
      const month = query.cutoff.slice(0, 7);
      const fullyObservedPartial = coverage && coverage.from <= `${month}-01` && coverage.through >= query.cutoff;
      const partial = entry.months.has(month) || fullyObservedPartial ? { month, physicalUnits: entry.months.get(month) ?? 0 } : null;
      const warnings: string[] = [];
      if (!input.manifest) warnings.push(RECORDING_WARNING);
      if (!coverage) warnings.push('No hay cobertura temporal verificable para construir meses completos de esta serie.');
      if (input.manifest && coverage && coverage.through < query.cutoff) warnings.push(`La cobertura declarada termina el ${coverage.through}. Los meses posteriores no se completan con ceros.`);
      if (entry.changedSize) warnings.push('Cambió el tamaño de esta presentación. Se conservan las piezas históricas y la equivalencia se calcula con el tamaño actual.');
      if (removedPresentations.has(product.id)) warnings.push('El producto tiene ventas de presentaciones retiradas que se excluyeron de las series actuales.');
      if (entry.invalidLines) warnings.push(`Se omitieron ${entry.invalidLines} líneas con cantidades físicas inválidas.`);
      if (!Number.isSafeInteger(presentation.units) || presentation.units <= 0) {
        warnings.push('El tamaño actual de la presentación es inválido. Corrígelo para calcular equivalencias.');
      }
      const ready = history.length >= 3 && Number.isSafeInteger(presentation.units) && presentation.units > 0;
      let method: ForecastMethod | null = null;
      let evaluation: ForecastEvaluation | null = null;
      if (ready) {
        method = 'moving-average-3';
        if (history.length >= 6) ({ method, evaluation } = evaluate(history));
        else warnings.push('Hay entre 3 y 5 meses completos. Se usa el promedio de 3 meses sin evaluación temporal.');
      } else warnings.push('Se requieren al menos 3 meses completos cubiertos y un tamaño de presentación válido.');
      const forecast: ForecastSeries['forecast'] = [];
      if (method) {
        const values = history.map(point => point.physicalUnits);
        const lastObserved = ordinal(history[history.length - 1].month);
        for (let offset = 1; offset <= query.horizon; offset++) {
          const target = cutoffMonth + offset;
          const physicalUnits = prediction(method, values, target - lastObserved);
          if (physicalUnits === Number.MAX_SAFE_INTEGER && !warnings.some(warning => warning.includes('límite numérico'))) {
            warnings.push('El pronóstico alcanzó el límite numérico seguro. Revisa las cantidades de origen.');
          }
          forecast.push({ month: monthAt(target), physicalUnits, presentationQuantity: Math.ceil(physicalUnits / presentation.units) });
        }
      }
      series.push({ id: JSON.stringify([product.id, presentation.id, query.location]), productId: product.id, productName: product.name, sku: product.sku,
        presentationId: presentation.id, presentationLabel: presentation.label, unitsPerPresentation: presentation.units,
        status: ready ? 'ready' : 'insufficient-history', method, history, partial, forecast, evaluation, warnings });
    }
  }
  return {
    version: 1, query: { ...query }, timeZone: 'America/Lima', unit: 'physical-items',
    source: { kind: input.manifest ? 'synthetic' : 'recorded', label: input.manifest?.label ?? 'Ventas registradas',
      datasetId: input.manifest?.id ?? null, observedThrough: input.manifest?.observedThrough ?? null },
    methodology: 'Solo se ajustan meses completos cubiertos, hasta 60. Desde 6 meses se comparan referencias mediante tres validaciones temporales de un paso. El mes parcial se muestra aparte y los horizontes comienzan después del mes del corte. MAE y sesgo se expresan en piezas físicas.',
    warnings: reportWarnings, series,
  };
}
