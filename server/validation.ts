import { z } from 'zod';

export const MAX_CENTS = 1_000_000_000;
const cents = z.number().int().min(0).max(MAX_CENTS);
const quantity = z.number().int().min(1).max(1_000_000);
const nonempty = z.string().trim().min(1).max(200);
export const locationSchema = z.enum(['puesto', 'almacen']);
export const paymentSchema = z.enum(['efectivo', 'yape', 'plin', 'transferencia']);
export const loginSchema = z.object({ email: z.email().max(200), password: z.string().min(1).max(200) }).strict();
export const presentationSchema = z.object({ id: nonempty, label: nonempty, units: quantity, priceCents: cents }).strict();
export const productSchema = z.object({
  name: nonempty, brand: z.string().trim().max(100), category: nonempty,
  barcode: z.string().trim().max(200).nullable(), active: z.boolean(),
  minStockUnits: z.number().int().min(0).max(1_000_000).nullable().optional(),
  minStockByPresentation: z.array(z.object({ presentationId: nonempty.nullable(), minimum: z.number().int().min(0).max(1_000_000_000) }).strict()).max(21).optional(),
  presentations: z.array(presentationSchema).max(20),
}).strict().superRefine((product, context) => {
  if (new Set(product.presentations.map(item => item.id)).size !== product.presentations.length) context.addIssue({ code: 'custom', path: ['presentations'], message: 'Las presentaciones deben tener identificadores únicos.' });
  const minima = product.minStockByPresentation ?? [];
  if (new Set(minima.map(item => item.presentationId)).size !== minima.length) context.addIssue({ code: 'custom', path: ['minStockByPresentation'], message: 'Configura un solo mínimo para cada presentación y para las unidades sueltas.' });
  for (const [index, minimum] of minima.entries()) {
    if (minimum.presentationId === null) continue;
    const presentation = product.presentations.find(item => item.id === minimum.presentationId);
    if (!presentation || presentation.units <= 1) context.addIssue({ code: 'custom', path: ['minStockByPresentation', index, 'presentationId'], message: 'El mínimo debe pertenecer a una presentación de este producto; usa unidades sueltas para la venta por unidad.' });
  }
});
export function isValidRuc(value: string) {
  if (!/^(10|15|16|17|20)\d{9}$/.test(value)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, weight, i) => acc + weight * Number(value[i]), 0);
  return (11 - sum % 11) % 10 === Number(value[10]);
}
export const customerSchema = z.object({
  documentType: z.enum(['DNI', 'RUC', 'SIN_DOCUMENTO']), document: z.string().trim().max(11),
  name: nonempty, address: z.string().trim().max(500),
}).strict().superRefine((customer, context) => {
  if (customer.documentType === 'DNI' && !/^\d{8}$/.test(customer.document)) context.addIssue({ code: 'custom', path: ['document'], message: 'El DNI debe tener 8 dígitos.' });
  if (customer.documentType === 'RUC' && !isValidRuc(customer.document)) context.addIssue({ code: 'custom', path: ['document'], message: 'El RUC no tiene un formato válido.' });
  if (customer.documentType === 'SIN_DOCUMENTO' && customer.document !== '') context.addIssue({ code: 'custom', path: ['document'], message: 'Un cliente sin documento no debe tener número de documento.' });
});
export const supplierSchema = z.object({
  ruc: z.string().refine(isValidRuc, 'El RUC no tiene un formato válido.'), name: nonempty,
  address: z.string().trim().max(500), phone: z.string().trim().max(30),
}).strict();
const itemSchema = z.object({ productId: nonempty, presentationId: nonempty, quantity, location: locationSchema }).strict();
export const saleSchema = z.object({
  idempotencyKey: z.string().min(8).max(128), documentType: z.enum(['ticket', 'boleta', 'factura']),
  customerId: nonempty.nullable(), paymentMethod: paymentSchema, paidCents: cents,
  items: z.array(itemSchema).min(1).max(100),
}).strict();
export const purchaseSchema = z.object({
  idempotencyKey: z.string().min(8).max(128), supplierId: nonempty,
  document: z.string().trim().max(100), location: locationSchema, paymentMethod: paymentSchema,
  paidFromCash: z.boolean(), totalPaidCents: cents.nullable(),
  items: z.array(z.object({ productId: nonempty, presentationId: nonempty, quantity, unitCostCents: cents.nullable() }).strict()).min(1).max(100),
}).strict();
const stockCountLines = z.array(z.object({
  presentationId: nonempty.nullable(), quantity: z.number().int().min(0).max(1_000_000_000),
}).strict()).min(1).max(21).refine(
  lines => new Set(lines.map(line => line.presentationId)).size === lines.length,
  'Ingresa cada presentación una sola vez.',
);
const optionalStockReason = z.string().trim().max(200).default('');
const adjustmentFields = { productId: nonempty, location: locationSchema, reason: optionalStockReason };
const transferFields = { productId: nonempty, from: locationSchema, to: locationSchema, reason: optionalStockReason, idempotencyKey: z.string().min(8).max(128).optional() };
// The strict union keeps existing clients compatible while rejecting requests
// that send both a base-unit total and presentation counts.
export const adjustSchema = z.union([
  z.object({ ...adjustmentFields, quantityUnits: z.number().int().min(0).max(1_000_000_000) }).strict(),
  z.object({ ...adjustmentFields, counts: stockCountLines }).strict(),
]);
export const transferSchema = z.union([
  z.object({ ...transferFields, quantityUnits: quantity }).strict(),
  z.object({ ...transferFields, counts: stockCountLines }).strict(),
]).refine(x => x.from !== x.to, 'El origen y el destino deben ser distintos.');
export const openCashSchema = z.object({ openingCents: cents }).strict();
export const closeCashSchema = z.object({ countedCents: cents }).strict();
export const cashMovementSchema = z.object({ idempotencyKey: z.string().min(8).max(128), type: z.enum(['ingreso', 'egreso']), amountCents: cents.min(1), reason: nonempty }).strict();
