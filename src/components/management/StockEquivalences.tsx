import type { LocationId, Product } from '../../../shared/types';
import { getPackagingStock } from '../../../shared/stock-packaging';
import { getLowStockAlerts, getPresentationMinimum } from '../../../shared/inventory';

const quantityText = (quantity: number) => quantity.toLocaleString('es-PE');

export default function StockPresentations({ product, location }: { product: Product; location: LocationId }) {
  const total = product.stock[location];
  if (total === null) return <span className="text-muted-foreground">Por contar</span>;
  const counts = getPackagingStock(product, location);
  if (counts === null) return <div className="min-w-44 space-y-1"><p className="text-sm font-medium tabular-nums">{quantityText(total)} {total === 1 ? 'unidad individual' : 'unidades individuales'}</p><p className="text-xs text-muted-foreground">Presentaciones por contar</p></div>;
  const lowStock = new Set(getLowStockAlerts(product, location).map(alert => alert.presentationId));
  return <div className="min-w-44 space-y-2">
    <ul className="space-y-2" aria-label="Existencias registradas por presentación">{counts.map(count => <li key={count.presentationId === null ? 'loose-units' : 'presentation:' + count.presentationId} className="break-words text-xs">
      <span className="font-semibold tabular-nums">{quantityText(count.quantity)}</span> {count.presentationId === null ? (count.quantity === 1 ? 'unidad suelta' : 'unidades sueltas') : '× ' + product.presentations.find(presentation => presentation.id === count.presentationId)!.label}
      {getPresentationMinimum(product, count.presentationId) !== null ? <p className={`mt-1 ${lowStock.has(count.presentationId) ? 'font-medium text-amber-800' : 'text-muted-foreground'}`}>Mínimo: {quantityText(getPresentationMinimum(product, count.presentationId)!)}{lowStock.has(count.presentationId) ? ' · Stock bajo' : ''}</p> : null}
    </li>)}</ul>
    <p className="border-t border-border/60 pt-2 text-xs text-muted-foreground tabular-nums">Total: {quantityText(total)} {total === 1 ? 'unidad individual' : 'unidades individuales'}</p>
  </div>;
}
