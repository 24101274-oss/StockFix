import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LocationId, Presentation, Product, User } from '../shared/types.js';
import { getPackagingStock, normalizePresentationCounts } from '../shared/stock-packaging.js';
import * as schema from './schema.js';

type Db = PgliteDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
interface Dependencies {
  atomic: <T>(action: (tx: Tx) => Promise<T>) => Promise<T>;
  requireAdmin: (request: FastifyRequest) => Promise<User>;
  getProduct: (tx: Tx, id: string) => Promise<Product>;
  recordStock: (tx: Tx, product: Product, location: LocationId, quantityUnits: number, type: string, reason: string, user: User) => Promise<void>;
  fail: (message: string, statusCode?: number) => never;
}
const inputSchema = z.object({
  idempotencyKey: z.string().min(8).max(128), productId: z.string().min(1).max(200),
  location: z.enum(['puesto', 'almacen']), fromPresentationId: z.string().min(1).max(200),
  toPresentationId: z.string().min(1).max(200).nullable(), quantity: z.number().int().min(1).max(1_000_000),
  reason: z.string().trim().min(1).max(200),
}).strict();

// Price and label changes preserve packaging. Changing the size of a pack with
// physical stock would change its meaning, so require the owner to count first.
export function prepareProductPackaging(product: Product, presentations: Presentation[]): Product['stockByPresentation'] {
  if (!product.stockByPresentation) return undefined;
  const result: NonNullable<Product['stockByPresentation']> = { puesto: null, almacen: null };
  for (const location of ['puesto', 'almacen'] as const) {
    const counts = getPackagingStock(product, location);
    if (!counts) continue;
    for (const count of counts) {
      if (count.presentationId === null || count.quantity === 0) continue;
      const old = product.presentations.find(item => item.id === count.presentationId)!;
      const next = presentations.find(item => item.id === count.presentationId);
      if (!next || next.units !== old.units) {
        throw Object.assign(new Error(`Hay existencias de «${old.label}» en ${location === 'puesto' ? 'el puesto' : 'el almacén'}. Abre esos empaques o corrige el conteo antes de quitar la presentación o cambiar su contenido.`), { statusCode: 409 });
      }
    }
    result[location] = normalizePresentationCounts(presentations, counts.filter(count => count.presentationId === null || presentations.some(item => item.id === count.presentationId)));
  }
  return result;
}

export function registerStockUnpacking(app: FastifyInstance, dependencies: Dependencies): void {
  const { atomic, requireAdmin, getProduct, recordStock } = dependencies;
  const fail: Dependencies['fail'] = dependencies.fail;
  app.post('/api/stock/unpack', async request => {
    const user = await requireAdmin(request);
    const input = inputSchema.parse(request.body);
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return atomic(async tx => {
      const [previous] = await tx.select().from(schema.stockPackagingRequests).where(eq(schema.stockPackagingRequests.idempotencyKey, input.idempotencyKey)).limit(1);
      if (previous) {
        if (previous.requestHash !== requestHash) fail('Este intento ya corresponde a otra apertura de empaques.', 409);
        return getProduct(tx, previous.productId);
      }
      const product = await getProduct(tx, input.productId);
      const counts = getPackagingStock(product, input.location);
      if (!counts) fail('Cuenta las presentaciones de esta ubicación antes de abrir empaques.', 409);
      const from = product.presentations.find(item => item.id === input.fromPresentationId);
      const to = input.toPresentationId === null ? null : product.presentations.find(item => item.id === input.toPresentationId);
      if (!from || input.toPresentationId !== null && !to) fail('La presentación cambió. Actualiza el producto antes de abrir empaques.', 409);
      const targetUnits = to?.units ?? 1;
      if (from.units <= targetUnits || from.units % targetUnits !== 0) fail('El contenido debe permitir convertir a una presentación más pequeña y exacta.');
      const sourceCount = counts.find(item => item.presentationId === from.id)!;
      if (sourceCount.quantity < input.quantity) fail('No hay suficientes empaques cerrados de esa presentación.', 409);
      const resultQuantity = input.quantity * (from.units / targetUnits);
      const targetCount = counts.find(item => item.presentationId === (targetUnits === 1 ? null : input.toPresentationId))!;
      sourceCount.quantity -= input.quantity;
      targetCount.quantity += resultQuantity;
      product.stockByPresentation = { puesto: null, almacen: null, ...product.stockByPresentation, [input.location]: counts };
      await tx.update(schema.products).set({ data: product }).where(eq(schema.products.id, product.id));
      const detail = `${input.quantity} × ${from.label} → ${resultQuantity} × ${to?.label ?? 'unidades sueltas'}. ${input.reason}`;
      await recordStock(tx, product, input.location, 0, 'apertura_empaque', detail, user);
      await tx.insert(schema.stockPackagingRequests).values({ idempotencyKey: input.idempotencyKey, requestHash, productId: product.id });
      return product;
    });
  });
}
