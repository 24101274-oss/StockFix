import { useState, type FormEvent } from 'react';
import type { LocationId, PresentationCount, Product } from '../../../shared/types';
import { ApiError, post } from '../../lib/api';
import { locations } from '../../lib/format';
import { getPackagingStock } from '../../../shared/stock-packaging';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { actionClass, controlClass, ErrorMessage, Field, ManagementDialog, messageOf } from './common';

interface TransferInput { idempotencyKey: string; productId: string; from: LocationId; to: LocationId; counts: PresentationCount[]; reason: string }
const pendingStorage = (userId: string, productId: string) => `stockfix:pending-transfer:v1:${userId}:${productId}`;
function loadTransfer(userId: string, productId: string): TransferInput | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingStorage(userId, productId)) || 'null');
    return value && value.productId === productId && typeof value.idempotencyKey === 'string' &&
      ['puesto', 'almacen'].includes(value.from) && ['puesto', 'almacen'].includes(value.to) && value.from !== value.to &&
      typeof value.reason === 'string' && Array.isArray(value.counts) && value.counts.length > 0 &&
      value.counts.every((count: PresentationCount) => (count.presentationId === null || typeof count.presentationId === 'string') && Number.isSafeInteger(count.quantity) && count.quantity >= 0) ? value : null;
  } catch { return null; }
}
function persistTransfer(userId: string, productId: string, input: TransferInput | null) {
  try {
    if (input) sessionStorage.setItem(pendingStorage(userId, productId), JSON.stringify(input));
    else sessionStorage.removeItem(pendingStorage(userId, productId));
  } catch { /* Retain the exact attempt in this tab if storage is unavailable. */ }
}
export default function StockEditor({ product, mode, userId, onClose, onSaved }: { product: Product; mode: 'adjust' | 'transfer'; userId: string; onClose: () => void; onSaved: (product: Product) => void }) {
  const [initialPending] = useState(() => mode === 'transfer' ? loadTransfer(userId, product.id) : null);
  const [pending, setPending] = useState<TransferInput | null>(initialPending);
  const [location, setLocation] = useState<LocationId>(initialPending?.from ?? 'puesto');
  const [quantities, setQuantities] = useState<Record<string, string>>(() => initialPending ? Object.fromEntries(initialPending.counts.map(count => [count.presentationId === null ? 'individual' : `presentation:${count.presentationId}`, String(count.quantity)])) : mode === 'adjust' ? quantitiesAt('puesto') : {});
  const [reason, setReason] = useState(initialPending?.reason ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const destination: LocationId = location === 'puesto' ? 'almacen' : 'puesto';
  const knownStock = product.stock[location];
  const packaging = getPackagingStock(product, location);
  const transfer = mode === 'transfer';
  const locked = busy || !!pending;
  const limit = transfer ? 1_000_000 : 1_000_000_000;
  const rows = [
    ...product.presentations.filter(presentation => presentation.units > 1).map(presentation => ({ key: `presentation:${presentation.id}`, presentationId: presentation.id as string | null, label: presentation.label, units: presentation.units })),
    { key: 'individual', presentationId: null, label: 'Unidades individuales sueltas', units: 1 },
  ];
  function quantitiesAt(place: LocationId): Record<string, string> {
    const existing = getPackagingStock(product, place);
    return existing ? Object.fromEntries(existing.map(count => [count.presentationId === null ? 'individual' : `presentation:${count.presentationId}`, String(count.quantity)])) : {};
  }
  const entered = rows.filter(row => (quantities[row.key] ?? '').trim() !== '');
  const validQuantities = entered.every(row => Number.isSafeInteger(Number(quantities[row.key])) && Number(quantities[row.key]) >= 0 && Number(quantities[row.key]) <= Math.floor(limit / row.units));
  const total = entered.length && validQuantities ? entered.reduce((sum, row) => sum + Number(quantities[row.key]) * row.units, 0) : null;
  const validTotal = total !== null && Number.isSafeInteger(total) && total <= limit && total >= (transfer ? 1 : 0);
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!pending && !entered.length) { setError('Ingresa la cantidad de al menos una presentación. Puedes escribir 0 para registrar que no hay existencias.'); return; }
    if (!transfer && entered.length !== rows.length) { setError('Completa todas las presentaciones y las unidades sueltas. Escribe 0 en las que no tengas existencias.'); return; }
    if (!pending && (!validQuantities || !validTotal)) { setError(transfer ? 'Ingresa cantidades enteras que sumen entre 1 y 1.000.000 de unidades individuales.' : 'Ingresa cantidades enteras que sumen entre 0 y 1.000.000.000 de unidades individuales.'); return; }
    if (!pending && transfer && (knownStock === null || product.stock[destination] === null)) { setError('Registra el conteo inicial de ambas ubicaciones antes de trasladar mercadería.'); return; }
    if (!pending && transfer && total !== null && total > (knownStock ?? 0)) { setError('La cantidad supera las existencias del origen.'); return; }
    const counts = entered.map(row => ({ presentationId: row.presentationId, quantity: Number(quantities[row.key]) }));
    const payload = transfer ? pending ?? { idempotencyKey: crypto.randomUUID(), productId: product.id, from: location, to: destination, counts, reason: reason.trim() } : { productId: product.id, location, counts, reason: reason.trim() };
    if (transfer) { setPending(payload as TransferInput); persistTransfer(userId, product.id, payload as TransferInput); }
    setBusy(true);
    try {
      const saved = await post<Product>(transfer ? '/stock/transfer' : '/stock/adjust', payload);
      if (transfer) { setPending(null); persistTransfer(userId, product.id, null); }
      onSaved(saved);
    }
    catch (error) {
      if (transfer && error instanceof ApiError && [400, 404, 409].includes(error.status)) { setPending(null); persistTransfer(userId, product.id, null); }
      setError(messageOf(error));
    }
    finally { setBusy(false); }
  }
  return <ManagementDialog open onClose={onClose} title={transfer ? 'Trasladar mercadería' : 'Conteo de existencias'} detail={product.name} busy={locked} wide>
    <form onSubmit={save} className="space-y-5"><ErrorMessage message={error} />{pending && !busy ? <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Hay un traslado pendiente de confirmar. Comprueba el mismo intento para obtener el resultado sin trasladar dos veces.</p> : null}<fieldset disabled={locked} className="space-y-4">
      <Field label={transfer ? 'Ubicación de origen' : 'Ubicación del conteo'}><select className={controlClass} value={location} onChange={(e) => { const place = e.target.value as LocationId; setLocation(place); setQuantities(transfer ? {} : quantitiesAt(place)); setError(''); }}>{Object.entries(locations).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
      <div className="rounded-xl bg-muted p-3 text-sm"><p>Total registrado: <strong>{knownStock === null ? 'Pendiente de conteo' : `${knownStock.toLocaleString('es-PE')} unidades individuales`}</strong></p>{transfer ? <p className="mt-1 text-muted-foreground">Destino: {locations[destination]} · {product.stock[destination] === null ? 'pendiente de conteo' : `${product.stock[destination].toLocaleString('es-PE')} unidades individuales`}</p> : null}</div>
      <div className="space-y-3"><h3 className="text-sm font-semibold">{transfer ? '¿Cuántas presentaciones vas a trasladar?' : '¿Cuántas presentaciones tienes en esta ubicación?'}</h3><p className="text-xs leading-relaxed text-muted-foreground">Cuenta cada grupo de mercadería una sola vez. Por ejemplo, registra los fardos cerrados y los paquetes que están fuera de esos fardos. {transfer ? 'Deja en blanco las presentaciones que no vas a trasladar.' : 'Escribe 0 en las presentaciones que no tengas.'}</p>
        {rows.map((row, index) => <div key={row.key} className="grid items-center gap-3 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,1fr)_180px]"><div><p className="break-words text-sm font-semibold">{row.label}</p><p className="mt-1 text-xs text-muted-foreground">{row.units === 1 ? 'Contiene 1 unidad individual' : `Cada presentación contiene ${row.units.toLocaleString('es-PE')} unidades individuales`}</p>{packaging ? <p className="mt-1 text-xs text-muted-foreground">Registradas: {packaging.find(count => count.presentationId === row.presentationId)?.quantity.toLocaleString('es-PE') ?? '0'}</p> : null}</div><Field label={`Cantidad · ${row.label}`}><Input className={controlClass} type="number" inputMode="numeric" min="0" max={Math.floor(limit / row.units)} step="1" required={!transfer} placeholder={transfer ? 'Sin trasladar' : '0 si no hay'} aria-label={`Cantidad de ${row.label}`} value={quantities[row.key] ?? ''} onChange={event => { setQuantities(current => ({ ...current, [row.key]: event.target.value })); setError(''); }} autoFocus={index === 0} /></Field></div>)}
      </div>
      <div role="status" aria-live="polite" className="rounded-xl border border-primary/20 bg-primary/5 p-4"><p className="text-sm font-medium">{transfer ? 'Total a trasladar' : 'Total del conteo'}: <strong>{total === null ? 'Por ingresar' : `${total.toLocaleString('es-PE')} unidades individuales`}</strong></p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{transfer ? 'Se descontará del origen y aumentará el destino.' : 'Este conteo reemplaza el stock total de la ubicación. Para una compra nueva, utiliza Entrada de productos.'}</p></div>
      <Field label="Motivo del movimiento (opcional)"><Input className={controlClass} maxLength={200} placeholder={knownStock === null ? 'Conteo inicial' : 'Revisión física de mercadería'} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </fieldset><div className="flex justify-end gap-2"><Button type="button" variant="outline" className={actionClass} onClick={onClose} disabled={locked}>Cancelar</Button><Button type="submit" className={actionClass} disabled={busy}>{busy ? 'Guardando…' : pending ? 'Comprobar el mismo intento' : transfer ? 'Confirmar traslado' : 'Guardar conteo'}</Button></div></form>
  </ManagementDialog>;
}
