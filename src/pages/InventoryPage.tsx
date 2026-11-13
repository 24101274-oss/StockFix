import { useMemo, useState } from 'react';
import { ArrowRightLeft, ClipboardCheck, PackageOpen, Pencil, Plus, Search, TriangleAlert } from 'lucide-react';
import type { LocationId, Product, StockMovement, User } from '../../shared/types';
import { getPresentationMinimum, isLowStock, matchesInventory, type InventoryStatus } from '../../shared/inventory';
import { getPackagingStock } from '../../shared/stock-packaging';
import { dateInLima, dateTime, locations, soles } from '../lib/format';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import ReportExport from '../components/ReportExport';
import ProductEditor from '../components/management/ProductEditor';
import StockEditor from '../components/management/StockEditor';
import StockPresentations from '../components/management/StockEquivalences';
import UnpackEditor from '../components/management/UnpackEditor';
import { actionClass, controlClass, EmptyState, Feedback, Metric, useResource } from '../components/management/common';

const PAGE_SIZE = 20;
function Pagination({ count, page, onChange }: { count: number; page: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  return <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
    <p className="text-xs text-muted-foreground">{count} registros · página {page} de {pages}</p>
    <div className="flex gap-2"><Button variant="outline" className={actionClass} disabled={page === 1} onClick={() => onChange(page - 1)}>Anterior</Button><Button variant="outline" className={actionClass} disabled={page === pages} onClick={() => onChange(page + 1)}>Siguiente</Button></div>
  </div>;
}
export default function InventoryPage({ user }: { user: User }) {
  const admin = user.role === 'admin';
  const products = useResource<Product[]>('/products', []);
  const movements = useResource<StockMovement[]>('/stock/movements', [], admin);
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState<LocationId>('puesto');
  const [status, setStatus] = useState<InventoryStatus>('all');
  const [tab, setTab] = useState<'products' | 'movements'>('products');
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [editor, setEditor] = useState<Product | 'new' | null>(null);
  const [stockEditor, setStockEditor] = useState<{ product: Product; mode: 'adjust' | 'transfer' } | null>(null);
  const [unpackEditor, setUnpackEditor] = useState<Product | null>(null);
  const invalidDates = !!(from && to && from > to);
  const filtered = useMemo(() => products.data.filter(product => matchesInventory(product, { query: search, location, status })), [products.data, search, location, status]);
  const filteredMovements = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es-PE');
    if (invalidDates) return [];
    return movements.data.filter(movement => {
      if (movement.location !== location) return false;
      if (term && ![movement.productName, movement.reason, movement.userName, movement.type].some(value => value.toLocaleLowerCase('es-PE').includes(term))) return false;
      const date = dateInLima(movement.createdAt);
      return (!from || date >= from) && (!to || date <= to);
    });
  }, [movements.data, search, location, from, to, invalidDates]);
  const count = tab === 'products' ? filtered.length : filteredMovements.length;
  const current = Math.min(page, Math.max(1, Math.ceil(count / PAGE_SIZE)));
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const visibleMovements = filteredMovements.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const lowCount = products.data.filter(product => isLowStock(product, location)).length;
  const legacyMinimumCount = products.data.filter(product => product.active && product.minStockUnits != null && product.minStockByPresentation === undefined).length;
  function productSaved(product: Product) {
    products.setData(items => items.some(item => item.id === product.id) ? items.map(item => item.id === product.id ? product : item) : [...items, product]);
    setEditor(null); setStockEditor(null); setUnpackEditor(null); void movements.refresh();
  }
  function changeTab(value: 'products' | 'movements') { setTab(value); setSearch(''); setPage(1); }
  function clearFilters() { setSearch(''); setStatus('all'); setFrom(''); setTo(''); setPage(1); }
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">Inventario</h1><p className="mt-1 text-sm text-muted-foreground">Productos, presentaciones y existencias en cada ubicación.</p></div>{admin ? <Button className={actionClass} onClick={() => setEditor('new')}><Plus />Nuevo producto</Button> : null}</div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Productos en catálogo" value={products.data.length} detail="Códigos internos únicos" />
      <Metric label="Pendientes de configurar" value={products.data.filter(product => product.active && !product.presentations.length).length} detail="Presentaciones y precios por confirmar" />
      <Metric label={'Por contar · ' + locations[location]} value={products.data.filter(product => product.active && getPackagingStock(product, location) === null).length} detail="Conteo por presentación pendiente; no se considera cero" />
      <Metric label={'Stock bajo · ' + locations[location]} value={lowCount} detail="Productos con alguna presentación en su mínimo o por debajo" />
    </div>
    {lowCount ? <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><span className="flex items-center gap-2"><TriangleAlert className="size-5 shrink-0" />{lowCount} {lowCount === 1 ? 'producto llegó' : 'productos llegaron'} al mínimo en {locations[location].toLocaleLowerCase('es-PE')}.</span><Button className={actionClass} variant="outline" onClick={() => { setTab('products'); setStatus('low'); setSearch(''); setPage(1); }}>Ver stock bajo</Button></div> : null}
    {legacyMinimumCount ? <p role="status" className="rounded-xl border border-border bg-muted p-3 text-sm">{legacyMinimumCount} {legacyMinimumCount === 1 ? 'producto tiene' : 'productos tienen'} un mínimo general anterior. Edita sus mínimos por presentación para activar las nuevas alertas.</p> : null}
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2"><Button className={actionClass} variant={tab === 'products' ? 'default' : 'outline'} onClick={() => changeTab('products')}>Productos</Button>{admin ? <Button className={actionClass} variant={tab === 'movements' ? 'default' : 'outline'} onClick={() => changeTab('movements')}>Movimientos</Button> : null}</div>
      {admin ? <ReportExport endpoint={tab === 'products' ? '/reports/inventory/export' : '/reports/stock/export'} params={tab === 'products' ? { query: search, location, status } : { query: search, location, ...(from ? { from } : {}), ...(to ? { to } : {}) }} disabled={tab === 'products' ? products.loading || !!products.error : movements.loading || !!movements.error || invalidDates} /> : null}
    </div>
    <Card className="gap-0 overflow-hidden py-0 shadow-none"><CardContent className="p-0">
      <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_190px_minmax(200px,1fr)]">
        <div className="relative"><Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" /><Input aria-label={tab === 'products' ? 'Buscar producto por nombre o código' : 'Buscar movimiento por producto, motivo o responsable'} className={controlClass + ' pl-10'} style={{ paddingLeft: 40 }} placeholder={tab === 'products' ? 'Producto, marca o código…' : 'Producto, motivo o responsable…'} value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></div>
        <select aria-label="Ubicación del inventario" className={controlClass} value={location} onChange={event => { setLocation(event.target.value as LocationId); setPage(1); }}>{Object.entries(locations).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        {tab === 'products' ? <select aria-label="Estado del producto" className={controlClass} value={status} onChange={event => { setStatus(event.target.value as InventoryStatus); setPage(1); }}><option value="all">Todos los productos</option><option value="ready">Configurados</option><option value="pending">Pendientes</option><option value="zero">Sin existencias</option><option value="low">Stock bajo</option><option value="inactive">Inactivos</option></select> : <div className="grid grid-cols-2 gap-3"><label className="space-y-1 text-xs text-muted-foreground">Desde<Input type="date" aria-label="Movimientos desde" className={controlClass} value={from} onChange={event => { setFrom(event.target.value); setPage(1); }} /></label><label className="space-y-1 text-xs text-muted-foreground">Hasta<Input type="date" aria-label="Movimientos hasta" className={controlClass} value={to} onChange={event => { setTo(event.target.value); setPage(1); }} /></label></div>}
        {search || status !== 'all' || from || to ? <Button variant="ghost" className={actionClass + ' justify-self-start'} onClick={clearFilters}>Limpiar filtros</Button> : null}
        {tab === 'movements' ? <p className="text-xs text-muted-foreground sm:col-span-2 xl:col-span-3">El rango incluye ambos días, según la hora de Perú. Se exportan todos los resultados de los filtros.</p> : null}
        {tab === 'products' ? <p className="text-xs text-muted-foreground sm:col-span-2 xl:col-span-3">Las existencias muestran las presentaciones registradas por separado. Si abres un fardo para vender paquetes, registra su apertura antes.</p> : null}
        {tab === 'movements' && invalidDates ? <p role="alert" className="text-sm text-destructive sm:col-span-2 xl:col-span-3">La fecha inicial debe ser anterior o igual a la fecha final.</p> : null}
      </div>
      {tab === 'products' ? <>
        <Feedback loading={products.loading} error={products.error} retry={() => void products.refresh()} />
        {!products.loading && !products.error ? visible.length ? <>
          <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-left text-sm"><caption className="sr-only">Inventario por ubicación con cantidades registradas de cada presentación y unidades sueltas</caption><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Producto</th><th className="px-4 py-3 font-medium">Presentaciones / precio final</th><th className="px-4 py-3 font-medium">Puesto · existencias</th><th className="px-4 py-3 font-medium">Almacén · existencias</th>{admin ? <th className="px-4 py-3 text-right font-medium">Acciones</th> : null}</tr></thead><tbody>{visible.map(product => <tr key={product.id} className="border-t border-border/70 align-top hover:bg-muted/20">
            <td className="max-w-64 px-4 py-4"><p className="font-medium">{product.name}</p><p className="mt-1 text-xs text-muted-foreground">{product.sku} · {product.brand || product.category}</p>{product.barcode ? <p className="mt-1 break-all text-xs text-muted-foreground">Código: {product.barcode}</p> : null}{!product.active ? <Badge variant="secondary" className="mt-2">Inactivo</Badge> : null}<p className="mt-2 text-xs text-muted-foreground">{product.minStockByPresentation?.length ? 'Mínimos configurados por presentación' : product.minStockUnits != null && product.minStockByPresentation === undefined ? 'Mínimos por presentación pendientes' : 'Mínimos sin configurar'}</p></td>
            <td className="max-w-60 px-4 py-4">{product.presentations.length ? product.presentations.map(presentation => <p key={presentation.id} className="mb-2 text-xs"><span className="font-medium">{presentation.label}</span> · {soles(presentation.priceCents)}<span className="block text-muted-foreground">Contiene {presentation.units.toLocaleString('es-PE')} {presentation.units === 1 ? 'unidad individual' : 'unidades individuales'}</span>{getPresentationMinimum(product, presentation.id) !== null ? <span className="block text-muted-foreground">Mínimo: {getPresentationMinimum(product, presentation.id)?.toLocaleString('es-PE')} {presentation.units === 1 ? 'unidades sueltas' : 'presentaciones'}</span> : null}</p>) : <Badge variant="secondary">Por configurar</Badge>}</td>
            {(['puesto', 'almacen'] as const).map(place => <td key={place} className="px-4 py-4"><StockPresentations product={product} location={place} />{isLowStock(product, place) ? <span className="mt-2 flex items-center gap-1 text-xs text-amber-800"><TriangleAlert className="size-3" />Stock bajo</span> : null}</td>)}
            {admin ? <td className="px-4 py-4"><div className="flex justify-end gap-1"><Button variant="ghost" className="min-h-11 min-w-11" aria-label={'Editar ' + product.name} title="Editar producto" onClick={() => setEditor(product)}><Pencil /></Button><Button variant="ghost" className="min-h-11 min-w-11" aria-label={'Contar existencias de ' + product.name} title="Contar por presentación" onClick={() => setStockEditor({ product, mode: 'adjust' })}><ClipboardCheck /></Button><Button variant="ghost" className="min-h-11 min-w-11" aria-label={'Trasladar ' + product.name} title="Trasladar mercadería" onClick={() => setStockEditor({ product, mode: 'transfer' })}><ArrowRightLeft /></Button><Button variant="ghost" className="min-h-11 min-w-11" aria-label={'Abrir empaques de ' + product.name} title="Abrir empaques" onClick={() => setUnpackEditor(product)}><PackageOpen /></Button></div></td> : null}
          </tr>)}</tbody></table></div><Pagination count={count} page={current} onChange={setPage} />
        </> : <EmptyState title="No encontramos productos" detail="Prueba otro nombre, código, ubicación o estado." /> : null}
      </> : <>
        <Feedback loading={movements.loading} error={movements.error} retry={() => void movements.refresh()} />
        {!movements.loading && !movements.error ? visibleMovements.length ? <>
          <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><caption className="sr-only">Movimientos de stock que coinciden con los filtros</caption><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">Producto y motivo</th><th className="px-4 py-3">Ubicación</th><th className="px-4 py-3">Piezas</th><th className="px-4 py-3">Responsable</th></tr></thead><tbody>{visibleMovements.map(movement => <tr key={movement.id} className="border-t border-border"><td className="px-4 py-4 text-xs text-muted-foreground">{dateTime(movement.createdAt)}</td><td className="px-4 py-4"><p className="font-medium">{movement.productName}</p><p className="mt-1 text-xs text-muted-foreground">{movement.reason} · {movement.type}</p></td><td className="px-4 py-4">{locations[movement.location]}</td><td className={'px-4 py-4 font-medium tabular-nums ' + (movement.quantityUnits > 0 ? 'text-primary' : '')}>{movement.quantityUnits > 0 ? '+' : ''}{movement.quantityUnits.toLocaleString('es-PE')}</td><td className="px-4 py-4 text-xs">{movement.userName}</td></tr>)}</tbody></table></div><Pagination count={count} page={current} onChange={setPage} />
        </> : <EmptyState title="No hay movimientos con estos filtros" detail="Las entradas, ventas, conteos y traslados aparecerán aquí con su responsable y ubicación." /> : null}
      </>}
    </CardContent></Card>
    {editor !== null ? <ProductEditor key={editor === 'new' ? 'new' : editor.id} product={editor === 'new' ? null : editor} onClose={() => setEditor(null)} onSaved={productSaved} /> : null}
    {stockEditor ? <StockEditor product={stockEditor.product} mode={stockEditor.mode} userId={user.id} onClose={() => setStockEditor(null)} onSaved={productSaved} /> : null}
    {unpackEditor ? <UnpackEditor product={unpackEditor} userId={user.id} onClose={() => setUnpackEditor(null)} onSaved={productSaved} /> : null}
  </div>;
}
