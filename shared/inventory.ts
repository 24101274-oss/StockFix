import type { LocationId, Product, StockPresentationAlert } from './types';
import { getPackagingStock } from './stock-packaging';

export type InventoryStatus = 'all' | 'pending' | 'zero' | 'ready' | 'low' | 'inactive';
export interface InventoryFilter { query?: string; location?: LocationId; status?: InventoryStatus }

export function getPresentationMinimum(product: Product, presentationId: string | null): number | null {
  const presentation = presentationId === null ? null : product.presentations.find(item => item.id === presentationId);
  if (presentationId !== null && !presentation) return null;
  const stockId = presentation?.units === 1 ? null : presentationId;
  const entries = Array.isArray(product.minStockByPresentation) ? product.minStockByPresentation.filter(item => item.presentationId === stockId) : [];
  if (entries.length !== 1) return null;
  const minimum = entries[0].minimum;
  return Number.isSafeInteger(minimum) && minimum >= 0 && minimum <= 1_000_000_000 ? minimum : null;
}

export function getLowStockAlerts(product: Product, location?: LocationId): StockPresentationAlert[] {
  if (!product.active) return [];
  const alerts: StockPresentationAlert[] = [];
  for (const place of location ? [location] : ['puesto', 'almacen'] as const) {
    const counts = getPackagingStock(product, place);
    // Base-unit totals from older versions cannot identify physical packs.
    // Never infer a minimum or an available packaging quantity from that total.
    if (counts === null) continue;
    for (const count of counts) {
      const minimum = getPresentationMinimum(product, count.presentationId);
      if (minimum === null || count.quantity > minimum) continue;
      alerts.push({ location: place, presentationId: count.presentationId,
        presentationLabel: count.presentationId === null ? 'Unidades sueltas' : product.presentations.find(item => item.id === count.presentationId)!.label,
        quantity: count.quantity, minimum });
    }
  }
  return alerts;
}

export function isLowStock(product: Product, location: LocationId): boolean {
  return getLowStockAlerts(product, location).length > 0;
}

export function matchesInventory(product: Product, filter: InventoryFilter): boolean {
  const search = (filter.query ?? '').trim().toLocaleLowerCase('es-PE');
  if (search && ![product.name, product.sku, product.barcode ?? '', product.brand, product.category]
    .some(value => value.toLocaleLowerCase('es-PE').includes(search))) return false;
  const location = filter.location ?? 'puesto';
  switch (filter.status ?? 'all') {
    case 'pending': return product.active && (getPackagingStock(product, location) === null || !product.presentations.length);
    case 'zero': return product.active && product.stock[location] === 0;
    case 'ready': return product.active && getPackagingStock(product, location) !== null && product.presentations.length > 0;
    case 'low': return isLowStock(product, location);
    case 'inactive': return !product.active;
    default: return true;
  }
}
