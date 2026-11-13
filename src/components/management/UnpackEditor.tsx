import { useState, type FormEvent } from 'react';
import type { LocationId, Product } from '../../../shared/types';
import { getPackagingStock, quantityInPresentation } from '../../../shared/stock-packaging';
import { ApiError, post } from '../../lib/api';
import { locations } from '../../lib/format';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { actionClass, controlClass, ErrorMessage, Field, ManagementDialog, messageOf } from './common';

interface UnpackInput {
  idempotencyKey: string; productId: string; location: LocationId;
  fromPresentationId: string; toPresentationId: string | null; quantity: number; reason: string;
}
const pendingStorage = (userId: string, productId: string) => `stockfix:pending-unpack:v1:${userId}:${productId}`;
function loadPending(userId: string, productId: string): UnpackInput | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingStorage(userId, productId)) || 'null');
    return value && value.productId === productId && typeof value.idempotencyKey === 'string' &&
      ['puesto', 'almacen'].includes(value.location) && typeof value.fromPresentationId === 'string' &&
      (value.toPresentationId === null || typeof value.toPresentationId === 'string') &&
      Number.isSafeInteger(value.quantity) && value.quantity > 0 && typeof value.reason === 'string' ? value : null;
  } catch { return null; }
}
function persistPending(userId: string, productId: string, pending: UnpackInput | null) {
  try {
    if (pending) sessionStorage.setItem(pendingStorage(userId, productId), JSON.stringify(pending));
    else sessionStorage.removeItem(pendingStorage(userId, productId));
  } catch { /* Keep the exact attempt in memory when browser storage is unavailable. */ }
}
export default function UnpackEditor({ product, userId, onClose, onSaved }: { product: Product; userId: string; onClose: () => void; onSaved: (product: Product) => void }) {
  const [initialPending] = useState(() => loadPending(userId, product.id));
  const [location, setLocation] = useState<LocationId>(initialPending?.location ?? 'puesto');
  const [fromId, setFromId] = useState(initialPending?.fromPresentationId ?? '');
  const [toId, setToId] = useState(initialPending?.toPresentationId ?? '');
  const [quantity, setQuantity] = useState(initialPending ? String(initialPending.quantity) : '1');
  const [reason, setReason] = useState(initialPending?.reason ?? 'Abrir empaque para vender por una presentación menor');
  const [pending, setPending] = useState<UnpackInput | null>(initialPending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sources = product.presentations.filter(item => item.units > 1 && (quantityInPresentation(product, location, item.id) ?? 0) > 0);
  const source = sources.find(item => item.id === fromId) ?? sources[0];
  const targets = source ? product.presentations.filter(item => item.units > 1 && item.units < source.units && source.units % item.units === 0) : [];
  const target = targets.find(item => item.id === toId);
  const targetUnits = target?.units ?? 1;
  const count = Number(quantity);
  const available = source ? quantityInPresentation(product, location, source.id) ?? 0 : 0;
  const preview = source && Number.isSafeInteger(count) && count > 0 ? count * (source.units / targetUnits) : null;
  const unknown = getPackagingStock(product, location) === null;
  const locked = busy || !!pending;

  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!pending && (!source || !Number.isSafeInteger(count) || count < 1 || count > available)) { setError('Elige un empaque y una cantidad entera que tengas disponible.'); return; }
    const payload = pending ?? { idempotencyKey: crypto.randomUUID(), productId: product.id, location, fromPresentationId: source!.id, toPresentationId: target?.id ?? null, quantity: count, reason: reason.trim() };
    setPending(payload); persistPending(userId, product.id, payload); setBusy(true);
    try {
      const saved = await post<Product>('/stock/unpack', payload);
      setPending(null); persistPending(userId, product.id, null); onSaved(saved);
    }
    catch (error) {
      if (error instanceof ApiError && [400, 404, 409].includes(error.status)) { setPending(null); persistPending(userId, product.id, null); }
      setError(messageOf(error));
    } finally { setBusy(false); }
  }
  return <ManagementDialog open onClose={onClose} title="Abrir empaques" detail={product.name} busy={locked}><form onSubmit={save} className="space-y-5"><ErrorMessage message={error} />
    {pending && !busy ? <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Hay una apertura pendiente de confirmar: {pending.quantity} × {product.presentations.find(item => item.id === pending.fromPresentationId)?.label ?? 'empaque'} en {locations[pending.location]}. Comprueba el mismo intento para confirmar el resultado sin abrir más empaques.</p> : null}
    <fieldset disabled={locked} className="space-y-4">
      <Field label="Ubicación"><select className={controlClass} value={location} onChange={event => { setLocation(event.target.value as LocationId); setFromId(''); setToId(''); setQuantity('1'); setError(''); }}>{Object.entries(locations).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
      {unknown ? <p className="rounded-xl bg-muted p-3 text-sm">Primero registra el conteo por presentación de esta ubicación.</p> : !sources.length ? <p className="rounded-xl bg-muted p-3 text-sm">No hay empaques cerrados disponibles para abrir.</p> : <>
        <Field label="Presentación que vas a abrir"><select className={controlClass} value={source?.id ?? ''} onChange={event => { setFromId(event.target.value); setToId(''); setQuantity('1'); }}>{sources.map(item => <option key={item.id} value={item.id}>{item.label} · {quantityInPresentation(product, location, item.id)} disponibles</option>)}</select></Field>
        <Field label="Convertir en"><select className={controlClass} value={target?.id ?? ''} onChange={event => setToId(event.target.value)}><option value="">Unidades individuales sueltas</option>{targets.map(item => <option key={item.id} value={item.id}>{item.label} · contiene {item.units.toLocaleString('es-PE')} unidades</option>)}</select></Field>
        <Field label="Cantidad de empaques a abrir"><Input className={controlClass} type="number" inputMode="numeric" min="1" max={available} step="1" required value={quantity} onChange={event => setQuantity(event.target.value)} /></Field>
        <p role="status" aria-live="polite" className="rounded-xl bg-primary/5 p-3 text-sm">{preview === null ? 'Ingresa una cantidad válida.' : `${count} × ${source?.label} se convertirá en ${preview.toLocaleString('es-PE')} × ${target?.label ?? 'unidades sueltas'}.`}<span className="mt-2 block text-xs text-muted-foreground">El total de mercadería se conserva. Registra esta operación cuando abras físicamente los empaques.</span></p>
        <Field label="Motivo"><Input className={controlClass} required maxLength={200} value={reason} onChange={event => setReason(event.target.value)} /></Field>
      </>}
    </fieldset><div className="flex justify-end gap-2"><Button type="button" variant="outline" className={actionClass} disabled={locked} onClick={onClose}>Cancelar</Button><Button type="submit" className={actionClass} disabled={busy || !pending && (unknown || !sources.length)}>{busy ? 'Guardando…' : pending ? 'Comprobar el mismo intento' : 'Confirmar apertura'}</Button></div>
  </form></ManagementDialog>;
}
