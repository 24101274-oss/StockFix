import type { Summary } from '../../shared/types';
import { locations } from '../lib/format';

const quantity = new Intl.NumberFormat('es-PE');

export default function StockAlertGroups({ products }: { products: Summary['lowStock'] }) {
  return <ul className="max-h-[32rem] space-y-3 overflow-y-auto" aria-label="Productos con alertas de stock">
    {products.map(product => <li key={product.productId} className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-semibold">{product.name}</h3><p className="mt-1 text-xs text-muted-foreground">{product.sku}</p></div>
        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900">{product.alerts.length} {product.alerts.length === 1 ? 'alerta' : 'alertas'}</span>
      </div>
      <ul className="mt-3 divide-y divide-amber-200/70" aria-label={`Presentaciones con stock bajo de ${product.name}`}>
        {product.alerts.map(alert => <li key={`${alert.location}:${alert.presentationId === null ? 'loose-units' : 'presentation:' + alert.presentationId}`} className="flex flex-wrap items-start justify-between gap-3 py-3 last:pb-0">
          <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{alert.presentationLabel}</p><p className="mt-1 text-xs text-muted-foreground">{locations[alert.location]}</p></div>
          <div className="text-right tabular-nums"><p className={`text-sm font-semibold ${alert.quantity === 0 ? 'text-destructive' : 'text-amber-900'}`}>{alert.quantity === 0 ? 'Agotado · 0 disponibles' : `${quantity.format(alert.quantity)} disponibles`}</p><p className="mt-1 text-xs text-muted-foreground">Mínimo: {quantity.format(alert.minimum)}</p></div>
        </li>)}
      </ul>
    </li>)}
  </ul>;
}
