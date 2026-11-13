import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Banknote, Barcode, Check, CirclePlus, LoaderCircle, Minus, Package, Plus, RefreshCw, Search, ShoppingBag, ShoppingCart, Smartphone, Trash2, TriangleAlert, UserRound, Wallet } from 'lucide-react';
import type { CashSession, Customer, DocumentType, LocationId, PaymentMethod, Product, Sale, SaleInput, SaleItemInput, Settings, User } from '../../shared/types';
import { api, ApiError, post } from '../lib/api';
import { cents, locations, paymentNames, soles } from '../lib/format';
import { quantityInPresentation } from '../../shared/stock-packaging';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import CustomerDialog from '../components/pos/CustomerDialog';
import ReceiptDialog from '../components/pos/ReceiptDialog';
import { documentNames } from '../components/Receipt';

const selectStyle = 'h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const payments: PaymentMethod[] = ['efectivo', 'yape', 'plin', 'transferencia'];
const lineKey = (line: SaleItemInput) => `${line.productId}:${line.presentationId}:${line.location}`;
const pendingStorage = (userId: string) => `stockfix:pending-sale:v1:${userId}`;
function readPending(userId: string): SaleInput | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingStorage(userId)) || 'null');
    return value?.version === 1 && value.sale?.idempotencyKey && Array.isArray(value.sale.items) ? value.sale : null;
  } catch { return null; }
}
function persistPending(userId: string, sale: SaleInput | null) {
  try {
    if (sale) sessionStorage.setItem(pendingStorage(userId), JSON.stringify({ version: 1, sale }));
    else sessionStorage.removeItem(pendingStorage(userId));
  } catch { /* El servidor conserva la clave aunque el navegador no permita almacenamiento. */ }
}

export default function PosPage({ user, onSale }: { user: User; onSale?: () => void }) {
  const [initialPending] = useState(() => readPending(user.id));
  const [pending, setPending] = useState<SaleInput | null>(initialPending);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cash, setCash] = useState<CashSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [scanNotice, setScanNotice] = useState('');
  const [category, setCategory] = useState('Todas');
  const [origin, setOrigin] = useState<LocationId>('puesto');
  const [shown, setShown] = useState(36);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [cart, setCart] = useState<SaleItemInput[]>(initialPending?.items ?? []);
  const [documentType, setDocumentType] = useState<DocumentType>(initialPending?.documentType ?? 'ticket');
  const [customerId, setCustomerId] = useState<string>(initialPending?.customerId ?? '');
  const [customerOpen, setCustomerOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(!!initialPending);
  const [payment, setPayment] = useState<PaymentMethod>(initialPending?.paymentMethod ?? 'efectivo');
  const [received, setReceived] = useState(initialPending ? (initialPending.paidCents / 100).toFixed(2) : '');
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const [nextProducts, nextCustomers, nextCash, nextSettings] = await Promise.all([
        api<Product[]>('/products'), api<Customer[]>('/customers'), api<CashSession | null>('/cash'), api<Settings>('/settings'),
      ]);
      setProducts(nextProducts); setCustomers(nextCustomers); setCash(nextCash); setSettings(nextSettings);
    } catch (error) { setLoadError(error instanceof Error ? error.message : 'No se pudo cargar el punto de venta.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const categories = useMemo(() => ['Todas', ...new Set(products.map((product) => product.category).filter(Boolean))], [products]);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase('es');
    return products.filter((product) => (category === 'Todas' || product.category === category) && (!search || `${product.name} ${product.sku} ${product.barcode || ''} ${product.brand}`.toLocaleLowerCase('es').includes(search)));
  }, [products, query, category]);
  const detailed = cart.map((line) => {
    const product = productMap.get(line.productId);
    const presentation = product?.presentations.find((item) => item.id === line.presentationId);
    return { line, product, presentation, total: (presentation?.priceCents ?? 0) * line.quantity };
  });
  const total = detailed.reduce((sum, item) => sum + item.total, 0);
  const quantity = cart.reduce((sum, line) => sum + line.quantity, 0);
  const selectedCustomer = customers.find((customer) => customer.id === customerId);
  const customerValid = documentType !== 'factura' || (selectedCustomer?.documentType === 'RUC' && /^\d{11}$/.test(selectedCustomer.document));
  const locked = submitting || !!pending;
  const hasReceivedAmount = received.trim() !== '';
  const paid = payment === 'efectivo' && hasReceivedAmount ? cents(received) : total;
  const enoughPaid = Number.isFinite(paid) && paid >= total;

  function reserved(productId: string, location: LocationId, lines = cart) {
    const product = productMap.get(productId);
    return lines.reduce((sum, line) => line.productId === productId && line.location === location ? sum + line.quantity * (product?.presentations.find((item) => item.id === line.presentationId)?.units ?? 0) : sum, 0);
  }
  function reservedPresentations(product: Product, presentationId: string, location: LocationId, lines = cart) {
    const unitSale = product.presentations.find(item => item.id === presentationId)?.units === 1;
    return lines.reduce((sum, line) => line.productId === product.id && line.location === location &&
      (unitSale ? product.presentations.find(item => item.id === line.presentationId)?.units === 1 : line.presentationId === presentationId) ? sum + line.quantity : sum, 0);
  }
  function validCart(next: SaleItemInput[]) {
    for (const line of next) {
      const product = productMap.get(line.productId);
      const presentation = product?.presentations.find((item) => item.id === line.presentationId);
      if (!product?.active || !presentation) { setError('Este producto aún necesita una presentación y precio confirmados.'); return false; }
      const stock = product.stock[line.location];
      if (stock === null) { setError(`El stock de ${product.name} en ${locations[line.location]} está pendiente de conteo.`); return false; }
      const packages = quantityInPresentation(product, line.location, presentation.id);
      if (packages !== null && reservedPresentations(product, presentation.id, line.location, next) > packages) { setError(`No hay suficientes ${presentation.label} de ${product.name}. Disponibles: ${packages}. Para vender una presentación menor, abre los empaques desde Inventario.`); return false; }
      if (reserved(product.id, line.location, next) > stock) { setError(`No alcanza el stock de ${product.name} en ${locations[line.location]}. Disponible: ${stock} unidades base.`); return false; }
    }
    return true;
  }
  function add(product: Product) {
    if (locked) return false;
    const presentation = product.presentations.find((item) => item.id === selections[product.id]) ?? product.presentations[0];
    if (!presentation) { setError('Confirma las presentaciones de este producto desde Inventario.'); return false; }
    const line = { productId: product.id, presentationId: presentation.id, quantity: 1, location: origin };
    const existing = cart.find((item) => lineKey(item) === lineKey(line));
    const next = existing ? cart.map((item) => lineKey(item) === lineKey(line) ? { ...item, quantity: item.quantity + 1 } : item) : [...cart, line];
    if (!validCart(next)) return false;
    setCart(next); setError('');
    return true;
  }
  function updateLine(index: number, changes: Partial<SaleItemInput>) {
    if (locked) return;
    const changed = { ...cart[index], ...changes };
    if (!Number.isSafeInteger(changed.quantity) || changed.quantity < 1) return;
    const merged = new Map<string, SaleItemInput>();
    cart.map((line, i) => i === index ? changed : line).forEach((line) => {
      const other = merged.get(lineKey(line));
      merged.set(lineKey(line), other ? { ...other, quantity: other.quantity + line.quantity } : line);
    });
    const next = [...merged.values()];
    if (validCart(next)) { setCart(next); setError(''); }
  }
  function scan(event: FormEvent) {
    event.preventDefault();
    if (locked) return;
    setScanNotice('');
    const code = query.trim();
    if (!code) { searchRef.current?.focus(); return; }
    const product = products.find((item) => item.barcode === code || item.sku.toLocaleLowerCase('es') === code.toLocaleLowerCase('es'));
    if (!product) { setError('Código no asociado a un producto. Puedes buscarlo por nombre o registrar su código en Inventario.'); return; }
    if (add(product)) {
      const presentation = product.presentations.find(item => item.id === selections[product.id]) ?? product.presentations[0];
      setScanNotice(`Agregado: ${product.name} · ${presentation.label} · ${locations[origin]}.`);
      setQuery(''); setShown(36);
    }
    searchRef.current?.focus();
  }
  function openPayment() {
    if (!cart.length || !customerValid || !validCart(cart)) return;
    setReceived(''); setError(''); setPaymentOpen(true);
  }
  async function completeSale(event: FormEvent) {
    event.preventDefault();
    if (submitting || (!pending && !enoughPaid)) return;
    const payload: SaleInput = pending ?? {
      idempotencyKey: crypto.randomUUID(), documentType, customerId: customerId || null,
      paymentMethod: payment, paidCents: paid, items: cart,
    };
    setSubmitting(true); setError(''); setPending(payload); persistPending(user.id, payload);
    let result: Sale | null = null;
    try { result = await post<Sale>('/sales', payload); }
    catch (error) {
      // La sesión vencida, límites temporales y fallos de red no prueban que el
      // servidor haya rechazado el cobro; conservamos el mismo intento.
      const definiteFailure = error instanceof ApiError && [400, 404, 409].includes(error.status);
      if (definiteFailure) { setPending(null); persistPending(user.id, null); }
      setError(error instanceof Error ? error.message : 'La conexión se interrumpió. Reintenta el mismo cobro para consultar o completar la venta sin duplicarla.');
    } finally { setSubmitting(false); }
    if (!result) return;
    setPending(null); persistPending(user.id, null); setCart([]); setPaymentOpen(false); setReceipt(result); setReceived(''); setCustomerId('');
    onSale?.(); void load();
  }

  if (loading && !products.length) return <Card><CardContent className="flex min-h-64 items-center justify-center gap-3 text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /> Cargando productos y caja…</CardContent></Card>;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="mb-1 text-xs font-semibold tracking-widest text-primary uppercase">Mostrador</p><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Nueva venta</h1><p className="mt-1 text-sm text-muted-foreground">Busca, escanea y cobra. Los precios ya son finales.</p></div>
        <Button variant="outline" className="h-11" disabled={loading || submitting} onClick={() => void load()}><RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} /> Actualizar</Button>
      </header>
      <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><TriangleAlert className="mt-0.5 size-4 shrink-0" /><p><strong>Modo de pruebas.</strong> Las ventas y documentos se guardan internamente. No se envían a NubeFact ni a SUNAT.</p></div>
      {loadError ? <div role="alert" className="rounded-2xl bg-destructive/10 p-4 text-destructive">{loadError} <Button variant="link" onClick={() => void load()}>Reintentar</Button></div> : null}
      {!cash || cash.closedAt ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4"><div className="flex items-center gap-3"><Wallet className="size-5 text-primary" /><div><p className="font-semibold">Abre la caja para registrar ventas</p><p className="text-sm text-muted-foreground">La apertura también permite separar el efectivo de los pagos digitales.</p></div></div><Button className="h-11" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: 'cash' }))}>Ir a caja <ArrowRight className="size-4" /></Button></div> : null}
      {pending ? <p role="status" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Hay un cobro cuyo resultado debe confirmarse. El carrito está protegido para evitar duplicados. <Button variant="link" onClick={() => setPaymentOpen(true)}>Reintentar el mismo cobro</Button></p> : null}
      {error && !paymentOpen ? <p role="alert" className="rounded-2xl bg-destructive/10 p-4 text-sm text-destructive">{error}</p> : null}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px] 2xl:grid-cols-[minmax(0,1fr)_410px]">
        <section className="min-w-0 space-y-4" aria-label="Catálogo de productos">
          <Card className="gap-0 py-4"><CardContent className="space-y-3 px-4">
            <div className="space-y-2"><form onSubmit={scan} className="relative"><Search className="pointer-events-none absolute top-3.5 left-3 size-5 text-muted-foreground" /><Input ref={searchRef} className="h-12 border-border bg-background pr-12 pl-11" placeholder="Buscar producto o escanear código…" aria-label="Buscar producto o escanear código" autoComplete="off" enterKeyHint="done" disabled={locked} value={query} onChange={(event) => { setQuery(event.target.value); setScanNotice(''); setShown(36); }} /><button type="submit" className="absolute top-0 right-0 flex h-12 w-12 items-center justify-center rounded-r-xl text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" aria-label="Agregar producto por código" title="Agregar código al carrito" disabled={locked}><Barcode className="size-5" /></button></form><p className="text-xs text-muted-foreground">Enfoca este campo, escanea y presiona Enter. Se agrega una presentación desde la ubicación seleccionada.</p><p role="status" aria-live="polite" className="text-xs text-primary">{scanNotice}</p></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-3 text-xs font-medium text-muted-foreground">Categoría<select className={selectStyle} value={category} onChange={(event) => { setCategory(event.target.value); setShown(36); }}>{categories.map((value) => <option key={value}>{value}</option>)}</select></label>
              <label className="flex items-center gap-3 text-xs font-medium text-muted-foreground">Origen<select className={selectStyle} value={origin} onChange={(event) => setOrigin(event.target.value as LocationId)}>{Object.entries(locations).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            </div>
          </CardContent></Card>
          <div className="flex items-center justify-between text-sm"><span className="font-medium">{filtered.length} productos</span><span className="text-xs text-muted-foreground">Disponibles por presentación · {origin === 'puesto' ? 'Puesto' : 'Almacén'}</span></div>
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {filtered.slice(0, shown).map((product) => {
              const presentation = product.presentations.find((item) => item.id === selections[product.id]) ?? product.presentations[0];
              const stock = product.stock[origin];
              const remaining = stock === null ? null : stock - reserved(product.id, origin);
              const packagingQuantity = presentation ? quantityInPresentation(product, origin, presentation.id) : null;
              const availablePackages = packagingQuantity === null || !presentation ? null : packagingQuantity - reservedPresentations(product, presentation.id, origin);
              const available = product.active && !!presentation && remaining !== null && remaining >= presentation.units && (availablePackages === null || availablePackages >= 1);
              const status = !product.active ? 'Inactivo' : !presentation ? 'Presentación pendiente' : stock === null ? 'Pendiente de conteo' : !available ? 'Sin stock disponible' : null;
              return <Card key={product.id} className="gap-0 py-0 shadow-none transition-shadow hover:shadow-md"><CardContent className="flex h-full flex-col p-4">
                <div className="mb-3 flex items-center justify-between gap-2"><div className="flex size-10 items-center justify-center rounded-xl bg-primary/8 text-primary"><ShoppingBag className="size-5" /></div><span className="rounded-md bg-muted px-2 py-1 text-[10px] font-semibold text-muted-foreground">{product.brand || product.category}</span></div>
                <h3 className="min-h-10 text-sm leading-snug font-semibold">{product.name}</h3><p className="mt-1 text-[11px] text-muted-foreground">{product.sku}</p>
                <div className="mt-3 flex-1"><label className="sr-only" htmlFor={`presentation-${product.id}`}>Presentación de {product.name}</label><select id={`presentation-${product.id}`} className={`${selectStyle} h-11 text-xs`} value={presentation?.id ?? ''} disabled={!product.presentations.length || locked} onChange={(event) => setSelections({ ...selections, [product.id]: event.target.value })}>{product.presentations.length ? product.presentations.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.units} un.</option>) : <option value="">Sin presentación confirmada</option>}</select>
                <div className="my-3 flex items-end justify-between gap-2"><span className="text-xl font-bold tracking-tight">{presentation ? soles(presentation.priceCents) : '—'}</span><span className="text-right text-[11px] text-muted-foreground">{stock === null ? 'Stock pendiente' : availablePackages === null ? `${remaining} unidades · presentaciones por contar` : `${Math.max(0, availablePackages)} × ${presentation?.label} disponibles`}</span></div>{availablePackages === 0 && remaining !== null && presentation && remaining >= presentation.units ? <p className="mb-3 text-xs text-amber-800">Para vender esta presentación, abre un empaque mayor desde Inventario.</p> : null}</div>
                <Button className="h-11 w-full" variant={available ? 'secondary' : 'outline'} disabled={!available || locked} onClick={() => add(product)}>{available ? <><Plus className="size-4" /> Agregar</> : status}</Button>
              </CardContent></Card>;
            })}
          </div>
          {!filtered.length ? <Card><CardContent className="py-12 text-center"><Package className="mx-auto mb-3 size-10 text-muted-foreground/50" /><p className="font-semibold">No encontramos productos</p><p className="mt-1 text-sm text-muted-foreground">Prueba con otro nombre, marca o código.</p></CardContent></Card> : null}
          {filtered.length > shown ? <Button variant="outline" className="h-11 w-full" onClick={() => setShown(shown + 36)}>Mostrar más productos</Button> : null}
        </section>

        <Card className="gap-0 py-0 xl:sticky xl:top-6"><CardContent className="p-5">
          <div className="mb-5 flex items-center justify-between"><h2 className="flex items-center gap-2 text-lg font-semibold"><ShoppingCart className="size-5 text-primary" /> Tu venta <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{quantity}</span></h2>{cart.length ? <Button variant="ghost" className="h-11 text-xs text-muted-foreground" disabled={locked} onClick={() => { setCart([]); setError(''); }}>Vaciar</Button> : null}</div>
          <div className="mb-4 grid grid-cols-3 gap-1 rounded-xl bg-muted p-1" aria-label="Tipo de documento">{(['ticket', 'boleta', 'factura'] as DocumentType[]).map((type) => <Button key={type} variant={documentType === type ? 'outline' : 'ghost'} className={`h-11 px-1 text-xs ${documentType === type ? 'bg-background shadow-sm' : ''}`} disabled={locked} onClick={() => { setDocumentType(type); if (type === 'factura' && selectedCustomer?.documentType !== 'RUC') setCustomerId(''); }}>{documentNames[type]}</Button>)}</div>
          <div className="mb-5 space-y-2"><div className="flex items-center justify-between"><label className="text-xs font-medium text-muted-foreground" htmlFor="sale-customer">Cliente {documentType === 'factura' ? '(RUC obligatorio)' : '(opcional)'}</label><Button variant="link" className="h-8 px-0 text-xs" disabled={locked} onClick={() => setCustomerOpen(true)}><CirclePlus className="size-3.5" /> Nuevo</Button></div><div className="relative"><UserRound className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" /><select id="sale-customer" className={`${selectStyle} pl-9`} disabled={locked} value={customerId} onChange={(event) => setCustomerId(event.target.value)}><option value="">{documentType === 'factura' ? 'Seleccionar cliente con RUC' : 'Consumidor final'}</option>{customers.filter((customer) => documentType !== 'factura' || customer.documentType === 'RUC').map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.document ? ` · ${customer.document}` : ''}</option>)}</select></div>{!customerValid ? <p className="text-xs text-amber-800">Registra o selecciona un cliente con RUC para la factura de prueba.</p> : null}</div>
          <div className="max-h-[450px] space-y-4 overflow-y-auto border-y border-border py-4">
            {!cart.length ? <div className="px-5 py-12 text-center"><div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-muted"><ShoppingCart className="size-7 text-muted-foreground/50" /></div><p className="font-semibold">Tu carrito está vacío</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Agrega productos del catálogo o escanea un código para comenzar.</p></div> : detailed.map(({ line, product, presentation, total: lineTotal }, index) => <div key={lineKey(line)} className="space-y-3">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-sm leading-snug font-semibold">{product?.name ?? 'Producto no disponible'}</p><p className="mt-1 text-xs text-muted-foreground">{presentation?.label ?? 'Presentación pendiente'} · {soles(presentation?.priceCents ?? 0)}</p></div><Button variant="ghost" className="size-11 shrink-0 text-muted-foreground" aria-label={`Quitar ${product?.name ?? 'producto'}`} disabled={locked} onClick={() => setCart(cart.filter((_, i) => i !== index))}><Trash2 className="size-4" /></Button></div>
              <div className="flex items-center justify-between gap-2"><div className="flex items-center rounded-xl border border-border"><Button variant="ghost" className="size-11 rounded-r-none" aria-label={`Disminuir cantidad de ${product?.name}`} disabled={locked || line.quantity <= 1} onClick={() => updateLine(index, { quantity: line.quantity - 1 })}><Minus className="size-3.5" /></Button><Input className="h-11 w-12 rounded-none border-0 bg-transparent px-1 text-center text-sm font-semibold" inputMode="numeric" value={line.quantity} disabled={locked} aria-label={`Cantidad de ${product?.name}`} onChange={(event) => updateLine(index, { quantity: Number(event.target.value) })} /><Button variant="ghost" className="size-11 rounded-l-none" aria-label={`Aumentar cantidad de ${product?.name}`} disabled={locked} onClick={() => updateLine(index, { quantity: line.quantity + 1 })}><Plus className="size-3.5" /></Button></div><p className="font-bold">{soles(lineTotal)}</p></div>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">Origen<select className={`${selectStyle} h-11 text-xs`} value={line.location} disabled={locked} onChange={(event) => updateLine(index, { location: event.target.value as LocationId })}>{Object.entries(locations).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            </div>)}
          </div>
          <div className="mt-5"><div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">Total a cobrar</span><span className="text-3xl font-bold tracking-tight">{soles(total)}</span></div><p className="mt-2 text-xs text-muted-foreground">Precio final · documento de prueba</p><Button className="mt-5 h-14 w-full text-base" disabled={!cart.length || !customerValid || !cash || !!cash.closedAt || loading || locked} onClick={openPayment}><Banknote className="size-5" /> Cobrar venta <ArrowRight className="ml-auto size-5" /></Button><p className="mt-3 text-center text-[11px] text-muted-foreground">El stock se descuenta al confirmar el cobro.</p></div>
        </CardContent></Card>
      </div>

      <CustomerDialog open={customerOpen} onOpenChange={setCustomerOpen} initialType={documentType === 'factura' ? 'RUC' : 'DNI'} onSaved={(customer) => { setCustomers((current) => [...current.filter((item) => item.id !== customer.id), customer]); setCustomerId(customer.id); }} />
      <ReceiptDialog sale={receipt} settings={settings} onClose={() => { setReceipt(null); searchRef.current?.focus(); }} />
      <Dialog open={paymentOpen} onOpenChange={(open) => { if (!submitting) setPaymentOpen(open); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" showCloseButton={!submitting}>
          <DialogHeader><DialogTitle>Confirmar cobro</DialogTitle><DialogDescription>{documentNames[documentType]} de prueba · {quantity} presentaciones · sin envío tributario</DialogDescription></DialogHeader>
          <form className="space-y-5" onSubmit={(event) => void completeSale(event)}>
            <div className="rounded-2xl bg-primary/8 p-5 text-center"><p className="text-xs font-medium text-muted-foreground">Total de la venta</p><p className="mt-1 text-4xl font-extrabold tracking-tight text-primary">{soles(total)}</p></div>
            <fieldset disabled={locked} className="space-y-2"><legend className="mb-2 text-sm font-semibold">Medio de pago</legend><div className="grid grid-cols-2 gap-2">{payments.map((method) => <Button key={method} type="button" className={`h-12 justify-start ${payment === method ? 'border-primary text-primary' : ''}`} variant="outline" onClick={() => setPayment(method)}>{method === 'efectivo' ? <Banknote className="size-4" /> : <Smartphone className="size-4" />} {paymentNames[method]}{payment === method ? <Check className="ml-auto size-4" /> : null}</Button>)}</div></fieldset>
            {payment === 'efectivo' ? <div className="space-y-3"><label className="block space-y-2 text-sm font-medium">Efectivo recibido (S/) · opcional<Input className="h-12 text-lg" type="number" min={total / 100} step="0.01" inputMode="decimal" placeholder="Pago exacto" disabled={locked} value={received} onChange={(event) => setReceived(event.target.value)} /></label><p className="text-xs text-muted-foreground">Déjalo vacío para registrar un pago exacto. Ingresa el efectivo recibido si quieres calcular el vuelto.</p><div className="flex flex-wrap gap-2"><Button variant="outline" className="h-11 flex-1" type="button" disabled={locked} onClick={() => setReceived((total / 100).toFixed(2))}>Exacto</Button>{[10, 20, 50, 100].map((amount) => <Button key={amount} className="h-11 flex-1" variant="outline" type="button" disabled={locked} onClick={() => setReceived(String(amount))}>S/ {amount}</Button>)}</div>{hasReceivedAmount ? <div className="flex items-center justify-between rounded-xl bg-muted px-4 py-3"><span className="text-sm">Vuelto</span><span className="text-xl font-bold">{soles(Number.isFinite(paid) ? Math.max(0, paid - total) : 0)}</span></div> : null}{!enoughPaid ? <p className="text-xs text-destructive">El efectivo debe cubrir el total. No se aceptan pagos parciales.</p> : null}</div> : null}
            {pending ? <p role="status" className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">Reintentaremos el mismo cobro con su identificador original. Si ya fue guardado, se recuperará la venta sin descontar nuevamente el stock.</p> : null}
            {error ? <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="h-13 w-full text-base" disabled={submitting || (!pending && !enoughPaid)}>{submitting ? <LoaderCircle className="size-5 animate-spin" /> : <Check className="size-5" />}{submitting ? 'Confirmando…' : pending ? 'Reintentar el mismo cobro' : 'Confirmar y guardar venta'}</Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
