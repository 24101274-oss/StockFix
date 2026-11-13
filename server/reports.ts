import ExcelJS from 'exceljs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LocationId, Product, Sale, StockMovement, Summary, User } from '../shared/types';
import { getLowStockAlerts, getPresentationMinimum, matchesInventory } from '../shared/inventory';
import { getPackagingStock } from '../shared/stock-packaging';
import { locationSchema, paymentSchema } from './validation';

const timezone = 'America/Lima';
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const locations: Record<LocationId, string> = { puesto: 'Puesto', almacen: 'Almacén' };
const documentNames = { ticket: 'Ticket interno', boleta: 'Boleta de prueba', factura: 'Factura de prueba' };
const paymentNames = { efectivo: 'Efectivo', yape: 'Yape', plin: 'Plin', transferencia: 'Transferencia' };
export function limaDate(value: string | Date): string {
  const parts = dateFormatter.formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}
const limaDateTime = (value: string) => `${limaDate(value)} ${timeFormatter.format(new Date(value))}`;
const matches = (values: string[], query: string) => values.some(value => value.toLocaleLowerCase('es-PE').includes(query.toLocaleLowerCase('es-PE').trim()));

export function buildSummary(sales: Sale[], products: Product[], cashOpen: boolean, currentDate: Date = new Date()): Summary {
  const today = limaDate(currentDate);
  const month = today.slice(0, 7);
  const activeSales = sales.filter(sale => !sale.cancelled);
  const todaySales = activeSales.filter(sale => limaDate(sale.createdAt) === today);
  const monthSales = activeSales.filter(sale => limaDate(sale.createdAt).slice(0, 7) === month);
  const daily = new Map<string, number>();
  for (const sale of activeSales) {
    const date = limaDate(sale.createdAt);
    daily.set(date, (daily.get(date) ?? 0) + sale.totalCents);
  }
  const week: Summary['week'] = [];
  for (let offset = 6; offset >= 0; offset--) {
    const date = limaDate(new Date(currentDate.getTime() - offset * 86_400_000));
    week.push({ date, totalCents: daily.get(date) ?? 0 });
  }
  const top = new Map<string, Summary['topProducts'][number]>();
  for (const sale of monthSales) {
    const productsInSale = new Set<string>();
    for (const item of sale.items) {
      const entry = top.get(item.productId) ?? { productId: item.productId, name: item.name, totalCents: 0, quantityUnits: 0, salesCount: 0 };
      entry.totalCents += item.totalCents;
      entry.quantityUnits += item.units;
      if (!productsInSale.has(item.productId)) entry.salesCount++;
      productsInSale.add(item.productId);
      top.set(item.productId, entry);
    }
  }
  const lowStock: Summary['lowStock'] = [];
  for (const product of products) {
    const alerts = getLowStockAlerts(product);
    if (alerts.length) lowStock.push({ productId: product.id, name: product.name, sku: product.sku, alerts });
  }
  return {
    todaySalesCents: todaySales.reduce((sum, sale) => sum + sale.totalCents, 0), todaySalesCount: todaySales.length,
    month, monthSalesCents: monthSales.reduce((sum, sale) => sum + sale.totalCents, 0), monthSalesCount: monthSales.length,
    productsCount: products.length,
    pendingProductsCount: products.filter(product => product.active && (!product.presentations.length || getPackagingStock(product, 'puesto') === null || getPackagingStock(product, 'almacen') === null)).length,
    lowStockCount: new Set(lowStock.map(item => item.productId)).size, lowStock, cashOpen, week,
    topProducts: [...top.values()].sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name, 'es')).slice(0, 5),
  };
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === '0000') return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const calendarDate = z.string().refine(isCalendarDate, 'La fecha debe ser una fecha válida con formato AAAA-MM-DD.');
const formatSchema = z.enum(['xlsx', 'csv']).default('xlsx');
const searchSchema = z.string().trim().max(200).default('');
const dateFields = { from: calendarDate.optional(), to: calendarDate.optional() };
const dateRange = (input: { from?: string; to?: string }, context: z.RefinementCtx) => {
  if (input.from && input.to && input.from > input.to) context.addIssue({ code: 'custom', path: ['to'], message: 'La fecha final no puede ser anterior a la inicial.' });
};
export const salesExportSchema = z.object({ format: formatSchema, query: searchSchema, ...dateFields, documentType: z.enum(['ticket', 'boleta', 'factura']).optional(), paymentMethod: paymentSchema.optional() }).strict().superRefine(dateRange);
export const stockExportSchema = z.object({ format: formatSchema, query: searchSchema, ...dateFields, location: locationSchema.optional() }).strict().superRefine(dateRange);
export const inventoryExportSchema = z.object({ format: formatSchema, query: searchSchema, location: locationSchema.default('puesto'), status: z.enum(['all', 'pending', 'zero', 'ready', 'low', 'inactive']).default('all') }).strict();
const inRange = (value: string, filter: { from?: string; to?: string }) => {
  const date = limaDate(value);
  return (!filter.from || date >= filter.from) && (!filter.to || date <= filter.to);
};
export function filterSales(sales: Sale[], filter: z.infer<typeof salesExportSchema>): Sale[] {
  return sales.filter(sale => inRange(sale.createdAt, filter) && (!filter.documentType || sale.documentType === filter.documentType) && (!filter.paymentMethod || sale.paymentMethod === filter.paymentMethod) && matches([`${sale.number} ${sale.customer?.name || 'Consumidor final'} ${sale.customer?.document || ''}`], filter.query)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function filterStockMovements(movements: StockMovement[], filter: z.infer<typeof stockExportSchema>): StockMovement[] {
  return movements.filter(movement => inRange(movement.createdAt, filter) && (!filter.location || movement.location === filter.location) && matches([movement.productName, movement.reason, movement.userName, movement.type], filter.query)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function filterInventory(products: Product[], filter: z.infer<typeof inventoryExportSchema>): Product[] {
  return products.filter(product => matchesInventory(product, filter)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

type Cell = string | number | null;
interface Column { title: string; width?: number; money?: boolean }
interface ReportTable { name: string; columns: Column[]; rows: Cell[][] }
const textColumn = (title: string, width = 22): Column => ({ title, width });
const moneyColumn = (title: string): Column => ({ title, width: 18, money: true });
export function csvCell(value: Cell): string {
  if (value === null) return '""';
  if (typeof value === 'number') return String(value);
  // A quoted CSV field can still be interpreted as a formula by a spreadsheet.
  // Prefix unsafe text; leave genuine numeric amounts and signed stock deltas numeric.
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function csvBuffer(table: ReportTable): Buffer {
  const rows = [table.columns.map(column => column.title), ...table.rows];
  return Buffer.from(`\uFEFF${rows.map(row => row.map(csvCell).join(';')).join('\r\n')}\r\n`, 'utf8');
}
export async function workbookBuffer(tables: ReportTable[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'StockFix';
  workbook.subject = 'Registros internos de prueba; no acredita emisión ante SUNAT.';
  for (const table of tables) {
    const sheet = workbook.addWorksheet(table.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = table.columns.map(column => ({ header: column.title, width: column.width ?? 22 }));
    sheet.addRows(table.rows);
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, table.rows.length + 1), column: table.columns.length } };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    sheet.getRow(1).height = 30;
    table.columns.forEach((column, index) => { if (column.money) sheet.getColumn(index + 1).numFmt = '"S/" #,##0.00'; });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function salesTables(sales: Sale[]): ReportTable[] {
  return [{ name: 'Ventas', columns: [textColumn('Número interno'), textColumn('Fecha (Lima)'), textColumn('Tipo de documento'), textColumn('Estado fiscal'), textColumn('Anulada'), textColumn('Cliente', 35), textColumn('Tipo documento cliente'), textColumn('Documento cliente'), textColumn('Medio de pago'), moneyColumn('Total (S/)'), moneyColumn('Recibido (S/)'), moneyColumn('Vuelto (S/)'), moneyColumn('Total vigente (S/)'), textColumn('Responsable')], rows: sales.map(sale => [sale.number, limaDateTime(sale.createdAt), documentNames[sale.documentType], sale.status, sale.cancelled ? 'Sí' : 'No', sale.customer?.name ?? 'Consumidor final', sale.customer?.documentType ?? 'SIN_DOCUMENTO', sale.customer?.document ?? '', paymentNames[sale.paymentMethod], sale.totalCents / 100, sale.paidCents / 100, sale.changeCents / 100, sale.cancelled ? 0 : sale.totalCents / 100, sale.userName]) },
  { name: 'Detalle', columns: [textColumn('Número interno'), textColumn('Fecha (Lima)'), textColumn('Estado fiscal'), textColumn('Anulada'), textColumn('Producto', 35), textColumn('ID producto'), textColumn('Presentación', 30), textColumn('Ubicación'), textColumn('Cantidad presentaciones'), textColumn('Piezas físicas'), moneyColumn('Precio presentación (S/)'), moneyColumn('Total línea (S/)')], rows: sales.flatMap(sale => sale.items.map(item => [sale.number, limaDateTime(sale.createdAt), sale.status, sale.cancelled ? 'Sí' : 'No', item.name, item.productId, item.presentationLabel, locations[item.location], item.quantity, item.units, item.unitPriceCents / 100, item.totalCents / 100])) }];
}
export function inventoryTables(products: Product[]): ReportTable[] {
  const stockStatus = (stock: number | null) => stock === null ? 'Por contar' : stock === 0 ? 'Sin existencias' : 'Contado';
  const presentationLabel = (product: Product, presentationId: string | null) => presentationId === null ? 'Unidades sueltas' : product.presentations.find(presentation => presentation.id === presentationId)!.label;
  const minimumText = (product: Product): string | null => {
    const stockPresentations = [...product.presentations.filter(presentation => presentation.units > 1).map(presentation => ({ id: presentation.id as string | null, label: presentation.label })), { id: null, label: 'Unidades sueltas' }];
    const minimums = stockPresentations.flatMap(presentation => {
      const minimum = getPresentationMinimum(product, presentation.id);
      return minimum === null ? [] : [`${presentation.label}: ${minimum}`];
    });
    return minimums.length ? minimums.join(' | ') : null;
  };
  const alertText = (product: Product, location: LocationId): string => {
    if (getPackagingStock(product, location) === null) return 'Por contar';
    if (!product.active) return 'Inactivo';
    const alerts = getLowStockAlerts(product, location);
    return alerts.length ? alerts.map(alert => `${alert.quantity} × ${alert.presentationLabel} (mínimo ${alert.minimum})`).join(' | ') : 'Sin alertas';
  };
  const presentationStock = (product: Product, location: LocationId): string => {
    const counts = getPackagingStock(product, location);
    return counts === null ? 'Por contar' : counts.map(count => count.presentationId === null
      ? `${count.quantity} unidades sueltas`
      : `${count.quantity} × ${product.presentations.find(presentation => presentation.id === count.presentationId)!.label}`).join(' | ');
  };
  const packagingRows: Cell[][] = products.flatMap(product => (['puesto', 'almacen'] as const).flatMap((location): Cell[][] => {
    const counts = getPackagingStock(product, location);
    if (counts === null) return [[product.sku, product.name, locations[location], 'Por contar', null, null, null, 'Por contar', null, 'Por contar']];
    const alerts = getLowStockAlerts(product, location);
    return counts.map(count => {
      const presentation = product.presentations.find(item => item.id === count.presentationId);
      const label = presentationLabel(product, count.presentationId);
      const units = count.presentationId === null ? 1 : presentation!.units;
      const minimum = getPresentationMinimum(product, count.presentationId);
      const state = !product.active ? 'Inactivo' : minimum === null ? 'Sin mínimo' : alerts.some(alert => alert.presentationId === count.presentationId) ? 'Stock bajo' : 'Disponible';
      return [product.sku, product.name, locations[location], label, units, count.quantity, count.quantity * units, 'Contado', minimum, state];
    });
  }));
  const presentationRows: Cell[][] = products.flatMap((product): Cell[][] => {
    const rows: Cell[][] = product.presentations.map(presentation => [product.sku, product.name, presentation.label, presentation.units, presentation.priceCents / 100, getPresentationMinimum(product, presentation.id)]);
    const looseMinimum = getPresentationMinimum(product, null);
    if (looseMinimum !== null && !product.presentations.some(presentation => presentation.units === 1)) rows.push([product.sku, product.name, 'Unidades sueltas (stock)', 1, null, looseMinimum]);
    return rows;
  });
  return [{ name: 'Inventario', columns: [textColumn('Código interno'), textColumn('Producto', 35), textColumn('Código de barras'), textColumn('Marca'), textColumn('Categoría'), textColumn('Activo'), textColumn('Puesto (piezas)'), textColumn('Estado puesto'), textColumn('Almacén (piezas)'), textColumn('Estado almacén'), textColumn('Total (piezas)'), textColumn('Mínimos por presentación', 60), textColumn('Presentaciones', 60), textColumn('Puesto por presentación', 60), textColumn('Almacén por presentación', 60), textColumn('Puesto · stock bajo', 60), textColumn('Almacén · stock bajo', 60)], rows: products.map(product => [product.sku, product.name, product.barcode ?? '', product.brand, product.category, product.active ? 'Sí' : 'No', product.stock.puesto, stockStatus(product.stock.puesto), product.stock.almacen, stockStatus(product.stock.almacen), product.stock.puesto === null || product.stock.almacen === null ? null : product.stock.puesto + product.stock.almacen, minimumText(product), product.presentations.length ? product.presentations.map(item => `${item.label}: ${item.units} piezas; S/ ${(item.priceCents / 100).toFixed(2)}`).join(' | ') : 'Por configurar', presentationStock(product, 'puesto'), presentationStock(product, 'almacen'), alertText(product, 'puesto'), alertText(product, 'almacen')]) },
  { name: 'Presentaciones', columns: [textColumn('Código interno'), textColumn('Producto', 35), textColumn('Presentación', 30), textColumn('Piezas físicas'), moneyColumn('Precio final (S/)'), textColumn('Mínimo (presentaciones)')], rows: presentationRows },
  { name: 'Existencias por presentación', columns: [textColumn('Código interno'), textColumn('Producto', 35), textColumn('Ubicación'), textColumn('Presentación', 30), textColumn('Unidades por presentación'), textColumn('Cantidad'), textColumn('Total unidades individuales'), textColumn('Estado del conteo'), textColumn('Mínimo (presentaciones)'), textColumn('Estado de stock')], rows: packagingRows }];
}
export function movementTables(movements: StockMovement[]): ReportTable[] {
  return [{ name: 'Movimientos', columns: [textColumn('Fecha (Lima)'), textColumn('Producto', 35), textColumn('ID producto'), textColumn('Ubicación'), textColumn('Movimiento'), textColumn('Variación (piezas)'), textColumn('Motivo', 40), textColumn('Responsable')], rows: movements.map(movement => [limaDateTime(movement.createdAt), movement.productName, movement.productId, locations[movement.location], movement.type, movement.quantityUnits, movement.reason, movement.userName]) }];
}

export interface ReportDependencies {
  requireAdmin: (request: FastifyRequest) => Promise<User>;
  loadSales: () => Promise<Sale[]>;
  loadProducts: () => Promise<Product[]>;
  loadMovements: () => Promise<StockMovement[]>;
}
export function registerReports(app: FastifyInstance, dependencies: ReportDependencies) {
  const fileReply = async (format: 'xlsx' | 'csv', basename: string, tables: ReportTable[]) => ({
    data: format === 'csv' ? csvBuffer(tables[0]) : await workbookBuffer(tables),
    type: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `stockfix-${basename}-PRUEBA.${format}`,
  });
  app.get('/api/reports/sales/export', async (request, reply) => {
    await dependencies.requireAdmin(request);
    const filter = salesExportSchema.parse(request.query);
    const result = await fileReply(filter.format, 'ventas', salesTables(filterSales(await dependencies.loadSales(), filter)));
    return reply.header('Content-Disposition', `attachment; filename="${result.filename}"`).type(result.type).send(result.data);
  });
  app.get('/api/reports/stock/export', async (request, reply) => {
    await dependencies.requireAdmin(request);
    const filter = stockExportSchema.parse(request.query);
    const result = await fileReply(filter.format, 'movimientos', movementTables(filterStockMovements(await dependencies.loadMovements(), filter)));
    return reply.header('Content-Disposition', `attachment; filename="${result.filename}"`).type(result.type).send(result.data);
  });
  app.get('/api/reports/inventory/export', async (request, reply) => {
    await dependencies.requireAdmin(request);
    const filter = inventoryExportSchema.parse(request.query);
    const result = await fileReply(filter.format, 'inventario', inventoryTables(filterInventory(await dependencies.loadProducts(), filter)));
    return reply.header('Content-Disposition', `attachment; filename="${result.filename}"`).type(result.type).send(result.data);
  });
}
