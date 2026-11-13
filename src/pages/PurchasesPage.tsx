import { useMemo, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, ChevronDown, PackagePlus, Plus, Search, Trash2 } from 'lucide-react';
import type { CashSession, LocationId, PaymentMethod, Product, Purchase, PurchaseInput, Supplier, SupplierInput, User } from '../../shared/types';
import { ApiError, post } from '../lib/api';
import { documentLookupAvailability, documentLookupFallback, documentLookupNotice, documentLookupValidation, useDocumentLookup } from '../lib/document-lookup';
import { cents, dateTime, locations, paymentNames, soles } from '../lib/format';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import SupplierEditor from '../components/management/SupplierEditor';
import { actionClass, controlClass, EmptyState, ErrorMessage, Feedback, Field, messageOf, useResource } from '../components/management/common';

interface ItemDraft { key: string; productId: string; presentationId: string; quantity: string; cost: string }
const pendingStorageKey = 'stockfix-purchase-pending-v1';
function loadPending(): PurchaseInput | null {
  try {
    const raw = sessionStorage.getItem(pendingStorageKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as PurchaseInput;
    return value && typeof value.idempotencyKey === 'string' && typeof value.supplierId === 'string' && Array.isArray(value.items) && value.items.length > 0 && ['puesto', 'almacen'].includes(value.location) ? value : null;
  }
  catch { return null; }
}

export default function PurchasesPage({ user }: { user: User }) {
  const purchases = useResource<Purchase[]>('/purchases', []);
  const products = useResource<Product[]>('/products', []);
  const suppliers = useResource<Supplier[]>('/suppliers', []);
  const cash = useResource<CashSession | null>('/cash', null);
  const [supplierId, setSupplierId] = useState('');
  const [ruc, setRuc] = useState('');
  const [document, setDocument] = useState('');
  const [location, setLocation] = useState<LocationId>('almacen');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('efectivo');
  const [paidFromCash, setPaidFromCash] = useState(false);
  const [totalPaid, setTotalPaid] = useState('');
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [productToAdd, setProductToAdd] = useState('');
  const [supplierEditor, setSupplierEditor] = useState(false);
  const [supplierLookup, setSupplierLookup] = useState<Partial<SupplierInput> | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const documentLookup = useDocumentLookup();
  const rucRef = useRef('');
  const [success, setSuccess] = useState<Purchase | null>(null);
  const [pending, setPending] = useState<PurchaseInput | null>(loadPending);
  const idempotencyKey = useRef(crypto.randomUUID());
  const productMap = useMemo(() => new Map(products.data.map((p) => [p.id, p])), [products.data]);
  const availableProducts = useMemo(() => products.data.filter((p) => p.active && p.presentations.length > 0 && `${p.name} ${p.sku} ${p.barcode || ''}`.toLowerCase().includes(productSearch.trim().toLowerCase())), [products.data, productSearch]);
  const knownCosts = items.length > 0 && items.every((item) => item.cost !== '' && Number.isFinite(Number(item.cost)) && Number.isSafeInteger(Number(item.quantity)));
  const costTotal = items.reduce((sum, item) => sum + (item.cost === '' ? 0 : cents(item.cost)) * Number(item.quantity || 0), 0);
  const unknownStock = items.some((item) => productMap.get(item.productId)?.stock[location] === null);
  const activeSupplier = suppliers.data.find((supplier) => supplier.id === supplierId);

  async function lookup() {
    setNotice(''); setError('');
    const document = ruc;
    const validation = documentLookupValidation('RUC', document);
    if (validation) { setError(validation); return; }
    const saved = suppliers.data.find((supplier) => supplier.ruc === ruc);
    if (saved) { setSupplierId(saved.id); setNotice('Datos guardados. Proveedor seleccionado; verifica su razón social y dirección.'); return; }
    try {
      const result = await documentLookup.query('RUC', document);
      if (!result || rucRef.current !== document) return;
      setSupplierLookup({ ruc: document, name: result.name, address: result.address });
      setNotice(`${documentLookupNotice(result)} ${result.name}. Usa “Nuevo proveedor” para guardar estos datos y seleccionarlo en la entrada.`);
    } catch (error) {
      if (rucRef.current === document) setNotice(documentLookupFallback(error));
    }
  }

  function addItem() {
    const product = productMap.get(productToAdd);
    if (!product || !product.presentations.length) return;
    setItems((current) => [...current, { key: crypto.randomUUID(), productId: product.id, presentationId: product.presentations[0].id, quantity: '1', cost: '' }]);
    setProductToAdd(''); setProductSearch(''); setSuccess(null);
  }
  const updateItem = (key: string, changes: Partial<ItemDraft>) => setItems((current) => current.map((item) => item.key === key ? { ...item, ...changes } : item));

  async function receive(event?: FormEvent) {
    event?.preventDefault(); setError(''); setSuccess(null);
    if (!pending && (!supplierId || items.length === 0)) { setError('Selecciona un proveedor y agrega al menos un producto.'); return; }
    if (!pending && items.some((item) => !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) <= 0 || (item.cost !== '' && (!Number.isFinite(Number(item.cost)) || cents(item.cost) < 0)))) { setError('Revisa las cantidades y costos. Las cantidades deben ser enteras mayores que cero.'); return; }
    if (!pending && totalPaid !== '' && (!Number.isFinite(Number(totalPaid)) || cents(totalPaid) < 0)) { setError('Revisa el importe pagado.'); return; }
    if (!pending && unknownStock) { setError(`Primero registra el conteo inicial de los productos seleccionados en ${locations[location]}. La entrada se sumará a esas existencias.`); return; }
    if (!pending && paidFromCash && (paymentMethod !== 'efectivo' || !cash.data || !totalPaid.trim() || cents(totalPaid) <= 0)) { setError('Para pagar desde caja necesitas una caja abierta, efectivo y un importe pagado mayor que cero.'); return; }
    const input: PurchaseInput = pending ?? {
      idempotencyKey: idempotencyKey.current, supplierId, document: document.trim(), location,
      paymentMethod, paidFromCash, totalPaidCents: totalPaid === '' ? null : cents(totalPaid),
      items: items.map((item) => ({ productId: item.productId, presentationId: item.presentationId, quantity: Number(item.quantity), unitCostCents: item.cost === '' ? null : cents(item.cost) })),
    };
    setBusy(true);
    // Keep the same transaction after a connection failure: retrying must not receive it twice.
    try { sessionStorage.setItem(pendingStorageKey, JSON.stringify(input)); } catch { /* This tab still retains the transaction in state. */ }
    try {
      const result = await post<Purchase>('/purchases', input);
      setPending(null); try { sessionStorage.removeItem(pendingStorageKey); } catch { /* Storage may be disabled. */ }
      setSuccess(result); setItems([]); setDocument(''); setTotalPaid(''); setPaidFromCash(false); idempotencyKey.current = crypto.randomUUID();
      purchases.setData((current) => [result, ...current.filter((purchase) => purchase.id !== result.id)]);
      void products.refresh(); void cash.refresh();
    } catch (error) {
      setError(messageOf(error));
      // Authentication failure on a retry does not settle the preceding receipt.
      if (!(error instanceof ApiError) || error.status >= 500 || error.status === 401 || error.status === 403) setPending(input);
      else { setPending(null); try { sessionStorage.removeItem(pendingStorageKey); } catch { /* Storage may be disabled. */ } }
    } finally { setBusy(false); }
  }

  if (user.role !== 'admin') return <EmptyState title="Acceso reservado" detail="Las entradas de mercadería y compras están disponibles para el administrador." />;
  return <div className="space-y-6"><div><h1 className="text-2xl font-semibold tracking-tight">Entrada de productos</h1><p className="mt-1 text-sm text-muted-foreground">Recibe mercadería pagada al momento y actualiza su ubicación.</p></div>
    {pending ? <Card className="border-primary/30 bg-primary/5 shadow-none"><CardContent className="space-y-3 p-5"><h2 className="font-semibold">Comprobar una recepción pendiente</h2><p className="text-sm leading-relaxed text-muted-foreground">La conexión se interrumpió durante el registro. Los datos del intento se conservaron. Reintenta para recuperar el resultado sin duplicar la mercadería ni el pago.</p><p className="text-xs text-muted-foreground">Proveedor: {suppliers.data.find((s) => s.id === pending.supplierId)?.name ?? pending.supplierId} · {pending.items.length} productos · {locations[pending.location]}</p><Button className={actionClass} disabled={busy} onClick={() => void receive()}>{busy ? 'Comprobando…' : 'Comprobar y recuperar resultado'}</Button></CardContent></Card> : null}
    <ErrorMessage message={error} />
    {success ? <div role="status" className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4"><CheckCircle2 className="mt-0.5 size-5 text-primary" /><div><p className="font-medium">Entrada {success.number} registrada</p><p className="mt-1 text-sm text-muted-foreground">La mercadería se agregó a {locations[success.location]}.</p></div></div> : null}
    <Feedback loading={products.loading || suppliers.loading} error={products.error || suppliers.error} retry={() => { void products.refresh(); void suppliers.refresh(); }} />
    {!products.loading && !suppliers.loading && !products.error && !suppliers.error ? <form onSubmit={receive}><fieldset disabled={busy || pending !== null || documentLookup.busy} className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
      <div className="space-y-5"><Card className="shadow-none"><CardContent className="space-y-4 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Proveedor y recepción</h2><Button variant="outline" type="button" className={actionClass} onClick={() => setSupplierEditor(true)}><Plus />Nuevo proveedor</Button></div><Field label="Proveedor"><select className={controlClass} required value={supplierId} onChange={(e) => { documentLookup.cancel(); setSupplierLookup(null); setNotice(''); setSupplierId(e.target.value); const selectedRuc = suppliers.data.find((s) => s.id === e.target.value)?.ruc ?? ''; rucRef.current = selectedRuc; setRuc(selectedRuc); }}><option value="">Selecciona un proveedor</option>{suppliers.data.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name} · {supplier.ruc}</option>)}</select></Field><Field label="Buscar proveedor por RUC"><div className="flex gap-2"><Input className={controlClass} inputMode="numeric" value={ruc} onChange={(e) => { documentLookup.cancel(); const nextRuc = e.target.value.replace(/\D/g, '').slice(0, 11); rucRef.current = nextRuc; setRuc(nextRuc); setSupplierId(''); setSupplierLookup(null); setNotice(''); setError(''); }} placeholder="RUC de 11 dígitos" /><Button variant="outline" type="button" className={actionClass} disabled={documentLookup.busy} onClick={() => void lookup()}><Search />{documentLookup.busy ? 'Consultando…' : 'Consultar RUC'}</Button></div></Field><p className="text-xs leading-relaxed text-muted-foreground">{documentLookupAvailability(documentLookup.status, 'RUC')}</p>{notice ? <p role="status" className="rounded-xl bg-muted p-3 text-xs leading-relaxed text-muted-foreground">{notice}</p> : null}{activeSupplier?.address ? <p className="text-xs text-muted-foreground">{activeSupplier.address}</p> : null}<div className="grid gap-4 sm:grid-cols-2"><Field label="Documento de compra (opcional)"><Input className={controlClass} placeholder="Ejemplo: F001-123" value={document} onChange={(e) => setDocument(e.target.value)} maxLength={100} /></Field><Field label="La mercadería ingresa a"><select className={controlClass} value={location} onChange={(e) => setLocation(e.target.value as LocationId)}>{Object.entries(locations).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field></div></CardContent></Card>
        <Card className="shadow-none"><CardContent className="space-y-4 p-5"><h2 className="font-semibold">Productos recibidos</h2><div className="grid gap-3 sm:grid-cols-[1fr_auto]"><div className="space-y-2"><Input aria-label="Filtrar productos para entrada" className={controlClass} placeholder="Buscar nombre, código o escanear…" value={productSearch} onChange={(e) => setProductSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} /><select aria-label="Producto para agregar a la entrada" className={controlClass} value={productToAdd} onChange={(e) => setProductToAdd(e.target.value)}><option value="">Selecciona un producto configurado</option>{availableProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></div><Button type="button" variant="outline" className={`${actionClass} self-end`} disabled={!productToAdd} onClick={addItem}><Plus />Agregar</Button></div><p className="text-xs text-muted-foreground">Si un producto no aparece, configura primero sus presentaciones en Inventario.</p>
          {items.length ? <div className="space-y-3">{items.map((item) => { const product = productMap.get(item.productId); const presentation = product?.presentations.find((p) => p.id === item.presentationId); return <div key={item.key} className="space-y-3 rounded-xl border border-border p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold">{product?.name ?? 'Producto no disponible'}</p><p className="mt-1 text-xs text-muted-foreground">{product?.sku}</p></div><Button variant="ghost" type="button" className="min-h-11 min-w-11" aria-label={`Quitar ${product?.name ?? 'producto'}`} onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}><Trash2 /></Button></div><div className="grid gap-3 sm:grid-cols-3"><Field label="Presentación"><select className={controlClass} value={item.presentationId} onChange={(e) => updateItem(item.key, { presentationId: e.target.value })}>{product?.presentations.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field><Field label="Cantidad recibida"><Input className={controlClass} type="number" min="1" step="1" required value={item.quantity} onChange={(e) => updateItem(item.key, { quantity: e.target.value })} /></Field><Field label="Costo por presentación (S/)" hint="Opcional por ahora"><Input className={controlClass} type="number" min="0" step="0.01" placeholder="Pendiente" value={item.cost} onChange={(e) => updateItem(item.key, { cost: e.target.value })} /></Field></div><p className="text-xs text-muted-foreground">{item.quantity || '0'} × {presentation?.units.toLocaleString('es-PE') ?? '—'} piezas = <strong className="text-foreground">{(Number(item.quantity || 0) * (presentation?.units ?? 0)).toLocaleString('es-PE')} piezas</strong> que ingresan a {locations[location]}.</p>{product?.stock[location] === null ? <p className="text-xs font-medium text-destructive">Falta el conteo inicial en esta ubicación. Regístralo antes de recibir.</p> : null}</div>; })}</div> : <EmptyState title="Agrega la mercadería recibida" detail="Selecciona el producto y después indica cuántos paquetes, cajas o fardos ingresan." />}
        </CardContent></Card></div>
      <div><Card className="shadow-none lg:sticky lg:top-6"><CardContent className="space-y-5 p-5"><div className="flex items-center gap-2"><PackagePlus className="size-5 text-primary" /><h2 className="font-semibold">Pago y confirmación</h2></div><p className="text-sm leading-relaxed text-muted-foreground">La compra se considera pagada al momento. Puedes completar los costos después.</p><Field label="Medio de pago"><select className={controlClass} value={paymentMethod} onChange={(e) => { setPaymentMethod(e.target.value as PaymentMethod); if (e.target.value !== 'efectivo') setPaidFromCash(false); }}>{Object.entries(paymentNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field><Field label="Importe total pagado (S/)" hint="Déjalo pendiente si aún no registrarás el importe. No se guardará como cero."><Input className={controlClass} type="number" min="0" step="0.01" placeholder="Pendiente" value={totalPaid} onChange={(e) => setTotalPaid(e.target.value)} /></Field>{knownCosts ? <div className="rounded-xl bg-muted p-3"><p className="text-xs text-muted-foreground">Suma de costos ingresados</p><p className="mt-1 font-semibold">{soles(costTotal)}</p><Button type="button" variant="link" className="mt-1 min-h-11 px-0" onClick={() => setTotalPaid((costTotal / 100).toFixed(2))}>Usar como importe pagado</Button></div> : null}<label className="flex items-start gap-3 text-sm" style={{ flexDirection: 'row' }}><input type="checkbox" className="mt-1 size-5 shrink-0 accent-primary" checked={paidFromCash} disabled={paymentMethod !== 'efectivo' || !cash.data || cash.loading || !!cash.error} onChange={(e) => setPaidFromCash(e.target.checked)} /><span>Pagar con el efectivo de caja<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{paymentMethod !== 'efectivo' ? 'Disponible para pagos en efectivo.' : cash.data ? 'Generará un único egreso asociado a esta compra.' : 'Abre una caja para utilizar esta opción.'}</span></span></label>{cash.error ? <p className="text-xs text-destructive">No se pudo verificar el estado de caja. Puedes recibir sin vincular el pago a caja.</p> : null}<div className="border-t border-border pt-4 text-sm"><p className="flex justify-between"><span className="text-muted-foreground">Productos</span><strong>{items.length}</strong></p><p className="mt-2 flex justify-between gap-2"><span className="text-muted-foreground">Destino</span><strong>{locations[location]}</strong></p></div><Button type="submit" className={`${actionClass} w-full`} disabled={busy || items.length === 0 || !supplierId || unknownStock}>{busy ? 'Registrando…' : 'Confirmar recepción'}</Button><p className="text-xs leading-relaxed text-muted-foreground">Se sumarán las piezas recibidas al stock y se guardará el responsable. Para repartir una compra entre ubicaciones, registra la recepción de cada destino.</p></CardContent></Card></div>
    </fieldset></form> : null}
    <Card className="gap-0 overflow-hidden py-0 shadow-none"><CardContent className="p-0"><h2 className="border-b border-border p-5 font-semibold">Entradas registradas</h2><Feedback loading={purchases.loading} error={purchases.error} retry={() => void purchases.refresh()} />{!purchases.loading && !purchases.error ? purchases.data.length ? <div className="divide-y divide-border">{purchases.data.map((purchase) => <details key={purchase.id} className="group"><summary className="flex min-h-16 cursor-pointer list-none flex-wrap items-center gap-3 px-5 py-4"><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{purchase.number} · {purchase.supplierName}</p><p className="mt-1 text-xs text-muted-foreground">{dateTime(purchase.createdAt)} · {locations[purchase.location]} · {purchase.document || 'Sin documento registrado'}</p></div><Badge variant="secondary">Recibida</Badge><span className="text-sm font-medium tabular-nums">{purchase.totalPaidCents === null ? 'Importe pendiente' : soles(purchase.totalPaidCents)}</span><ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" /></summary><div className="space-y-3 border-t border-border bg-muted/20 px-5 py-4"><p className="text-xs text-muted-foreground">Responsable: {purchase.userName} · {paymentNames[purchase.paymentMethod]} · {purchase.paidFromCash ? 'Pago desde caja' : 'Pago fuera de caja'}</p>{purchase.items.map((item, index) => { const product = productMap.get(item.productId); const presentation = product?.presentations.find((p) => p.id === item.presentationId); return <div key={`${item.productId}-${index}`} className="flex flex-wrap justify-between gap-2 text-sm"><span>{product?.name ?? item.productId} · {item.quantity} {presentation?.label ?? 'presentaciones'}</span><span className="text-muted-foreground">{item.unitCostCents === null ? 'Costo pendiente' : `${soles(item.unitCostCents)} c/u`}</span></div>; })}</div></details>)}</div> : <EmptyState title="Aún no hay entradas registradas" detail="Las recepciones confirmadas aparecerán aquí con proveedor, documento, destino y responsable." /> : null}</CardContent></Card>
    {supplierEditor ? <SupplierEditor initial={supplierLookup?.ruc === ruc ? supplierLookup : { ruc }} onClose={() => setSupplierEditor(false)} onSaved={(supplier) => { suppliers.setData((current) => [...current.filter((s) => s.id !== supplier.id), supplier]); setSupplierId(supplier.id); rucRef.current = supplier.ruc; setRuc(supplier.ruc); setSupplierEditor(false); }} /> : null}
  </div>;
}
