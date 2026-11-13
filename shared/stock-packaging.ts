import type { LocationId, Presentation, PresentationCount, Product } from './types';

const DEFAULT_MAXIMUM = 1_000_000_000;

/** Counts represent separate physical stock: presentationId null means loose individual units. */
export function countStockUnits(presentations: readonly Presentation[], counts: readonly PresentationCount[], maximum = DEFAULT_MAXIMUM): number {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('El límite de existencias debe ser un entero no negativo.');
  const unitsById = new Map<string, number>();
  for (const presentation of presentations) {
    if (typeof presentation.id !== 'string' || !presentation.id.trim()) throw new Error('Cada presentación debe tener un identificador válido.');
    if (unitsById.has(presentation.id)) throw new Error('Las presentaciones del producto no deben repetirse.');
    if (!Number.isSafeInteger(presentation.units) || presentation.units <= 0) throw new Error('El contenido de cada presentación debe ser un entero mayor que cero.');
    unitsById.set(presentation.id, presentation.units);
  }
  const counted = new Set<string | null>();
  let total = 0;
  for (const count of counts) {
    if (count.presentationId !== null && !unitsById.has(count.presentationId)) throw new Error('Una presentación contada no pertenece a este producto.');
    if (counted.has(count.presentationId)) throw new Error('No repitas una presentación ni las unidades sueltas en el conteo.');
    if (!Number.isSafeInteger(count.quantity) || count.quantity < 0) throw new Error('La cantidad de cada presentación debe ser un entero no negativo.');
    counted.add(count.presentationId);
    const units = count.presentationId === null ? 1 : unitsById.get(count.presentationId)!;
    const subtotal = count.quantity * units;
    if (!Number.isSafeInteger(subtotal) || subtotal > maximum - total) throw new Error('Las existencias superan el límite permitido de unidades individuales.');
    total += subtotal;
  }
  return total;
}

/** Fill absent packages with zero; unit-sale presentations share the canonical loose-unit balance. */
export function normalizePresentationCounts(presentations: readonly Presentation[], counts: readonly PresentationCount[]): PresentationCount[] {
  countStockUnits(presentations, counts);
  const quantities = new Map(counts.map(count => [count.presentationId, count.quantity]));
  const looseQuantity = presentations.reduce((total, presentation) => total + (presentation.units === 1 ? quantities.get(presentation.id) ?? 0 : 0), quantities.get(null) ?? 0);
  return [
    ...presentations.filter(presentation => presentation.units > 1).map(presentation => ({ presentationId: presentation.id, quantity: quantities.get(presentation.id) ?? 0 })),
    { presentationId: null, quantity: looseQuantity },
  ];
}

/** Legacy stock or an inconsistent breakdown is unknown, never an inferred package balance. */
export function getPackagingStock(product: Product, location: LocationId): PresentationCount[] | null {
  const total = product.stock[location];
  const counts = product.stockByPresentation?.[location];
  if (total === null || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(counts)) return null;
  try {
    if (countStockUnits(product.presentations, counts) !== total) return null;
    return normalizePresentationCounts(product.presentations, counts);
  } catch {
    return null;
  }
}

export function quantityInPresentation(product: Product, location: LocationId, presentationId: string | null): number | null {
  const counts = getPackagingStock(product, location);
  const stockId = product.presentations.find(presentation => presentation.id === presentationId)?.units === 1 ? null : presentationId;
  return counts === null ? null : counts.find(count => count.presentationId === stockId)?.quantity ?? 0;
}
