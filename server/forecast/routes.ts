import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SyntheticManifest } from '../../shared/demo-dataset.js';
import { FORECAST_METHOD_LABELS, type ForecastQuery, type ForecastReport, type ForecastSeries } from '../../shared/forecast.js';
import type { Product, Sale, User } from '../../shared/types.js';
import { csvBuffer, limaDate, workbookBuffer } from '../reports.js';
import { buildForecast } from './engine.js';

export interface ForecastDependencies {
  requireAdmin: (request: FastifyRequest) => Promise<User>;
  loadProducts: () => Promise<Product[]>;
  loadSales: () => Promise<Sale[]>;
  loadManifest: () => Promise<SyntheticManifest | null>;
  now?: () => Date;
}

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const queryFields = {
  cutoff: z.string().refine(isCalendarDate, 'El corte debe ser una fecha válida AAAA-MM-DD.'),
  horizon: z.string().regex(/^(?:[1-9]|1[0-2])$/, 'El horizonte debe ser un entero de 1 a 12 meses.').optional().transform(value => value === undefined ? 3 : Number(value)),
  location: z.enum(['all', 'puesto', 'almacen']).default('all'),
  productId: z.string().trim().min(1).max(120).optional(),
};
const querySchema = z.object(queryFields).strict();
const exportSchema = z.object({ ...queryFields, format: z.enum(['csv', 'xlsx']).default('xlsx') }).strict();
type ExportTable = Parameters<typeof csvBuffer>[0];
type ExportRow = ExportTable['rows'][number];

function forecastTables(report: ForecastReport): ExportTable[] {
  const columns = [
    'Origen', 'Etiqueta de origen', 'Dataset', 'Corte (Lima)', 'Ubicación', 'Unidad',
    'Producto', 'SKU', 'ID producto', 'ID presentación', 'Presentación actual', 'Piezas por presentación',
    'Estado', 'Método', 'Tipo de dato', 'Mes', 'Piezas físicas', 'Equivalente en presentaciones actuales',
    'MAE (piezas)', 'Sesgo (piezas)', 'MAE referencia (piezas)', 'Meses de evaluación', 'Pliegues', 'Advertencias',
  ].map(title => ({ title, width: ['Advertencias', 'Producto', 'Etiqueta de origen'].includes(title) ? 50 : 25 }));
  const common = [report.source.kind, report.source.label, report.source.datasetId, report.query.cutoff, report.query.location, report.unit];
  const row = (series: ForecastSeries | null, kind: string, month: string | null, physicalUnits: number | null, presentationQuantity: number | null): ExportRow => [
    ...common,
    series?.productName ?? null, series?.sku ?? null, series?.productId ?? null, series?.presentationId ?? null,
    series?.presentationLabel ?? null, series?.unitsPerPresentation ?? null, series?.status ?? null,
    series?.method ? FORECAST_METHOD_LABELS[series.method] : null, kind, month, physicalUnits, presentationQuantity,
    series?.evaluation?.mae ?? null, series?.evaluation?.bias ?? null, series?.evaluation?.baselineMae ?? null,
    series?.evaluation?.months.join(' | ') ?? null, series?.evaluation?.folds ?? null,
    [...report.warnings, ...(series?.warnings ?? [])].join(' | '),
  ];
  // A metadata row keeps source and cut visible even for an empty report.
  const rows: ExportRow[] = [row(null, 'Metadatos del reporte', null, null, null)];
  for (const series of report.series) {
    rows.push(...series.history.map(point => row(series, 'Histórico completo', point.month, point.physicalUnits, null)));
    if (series.partial) rows.push(row(series, 'Mes parcial (excluido del ajuste)', series.partial.month, series.partial.physicalUnits, null));
    rows.push(...series.forecast.map(point => row(series, 'Pronóstico', point.month, point.physicalUnits, point.presentationQuantity)));
    if (!series.history.length && !series.partial && !series.forecast.length) rows.push(row(series, 'Sin datos suficientes', null, null, null));
  }
  return [
    { name: 'Reporte mensual', columns, rows },
    {
      name: 'Evaluación',
      columns: ['ID producto', 'ID presentación', 'Método candidato', 'Seleccionado', 'MAE (piezas)', 'Sesgo (piezas)', 'Meses de evaluación', 'Pliegues'].map(title => ({ title, width: 28 })),
      rows: report.series.flatMap(series => series.evaluation?.candidates.map(candidate => [series.productId, series.presentationId, FORECAST_METHOD_LABELS[candidate.method], candidate.method === series.method ? 'Sí' : 'No', candidate.mae, candidate.bias, series.evaluation!.months.join(' | '), series.evaluation!.folds]) ?? []),
    },
    {
      name: 'Metodología', columns: [{ title: 'Campo', width: 30 }, { title: 'Valor', width: 110 }],
      rows: [
        ['Origen', report.source.label], ['Dataset', report.source.datasetId], ['Corte (Lima)', report.query.cutoff],
        ['Observado hasta', report.source.observedThrough], ['Zona horaria', report.timeZone], ['Horizonte mensual', report.query.horizon],
        ['Unidad', report.unit], ['Método de evaluación', report.methodology],
        ['Equivalentes', 'El número de presentaciones es un redondeo hacia arriba con el tamaño actual; no representa un conteo de empaques cerrados.'],
        ['Advertencias', report.warnings.join(' | ')],
      ],
    },
  ];
}

export function registerForecast(app: FastifyInstance, dependencies: ForecastDependencies) {
  async function reportFor(query: ForecastQuery) {
    const [year, month] = query.cutoff.split('-').map(Number);
    if (year * 12 + month - 1 + query.horizon > 9999 * 12 + 11) throw Object.assign(new Error('El horizonte no puede superar diciembre del año 9999.'), { statusCode: 400 });
    const today = limaDate(dependencies.now?.() ?? new Date());
    if (query.cutoff > today) throw Object.assign(new Error('El corte no puede ser posterior a la fecha actual de Lima.'), { statusCode: 400 });
    const [products, sales, manifest] = await Promise.all([dependencies.loadProducts(), dependencies.loadSales(), dependencies.loadManifest()]);
    if (query.productId && !products.some(product => product.id === query.productId)) throw Object.assign(new Error('Producto no encontrado.'), { statusCode: 404 });
    return buildForecast({ products, sales, manifest, query });
  }
  app.get('/api/forecast', async (request, reply) => {
    await dependencies.requireAdmin(request);
    const report = await reportFor(querySchema.parse(request.query));
    return reply.header('X-StockFix-Forecast-Cutoff', report.query.cutoff).header('X-StockFix-Data-Origin', report.source.kind).send(report);
  });
  app.get('/api/forecast/export', async (request, reply) => {
    await dependencies.requireAdmin(request);
    const { format, ...query } = exportSchema.parse(request.query);
    const report = await reportFor(query);
    const tables = forecastTables(report);
    const buffer = format === 'csv' ? csvBuffer(tables[0]) : await workbookBuffer(tables);
    return reply.header('Content-Disposition', `attachment; filename="stockfix-pronostico-${report.query.cutoff}-PRUEBA.${format}"`)
      .header('X-StockFix-Forecast-Cutoff', report.query.cutoff).header('X-StockFix-Data-Origin', report.source.kind)
      .type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
  });
}
