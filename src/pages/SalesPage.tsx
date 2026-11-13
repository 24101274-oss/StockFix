import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, CalendarDays, FileText, LoaderCircle, ReceiptText, RefreshCw, Search } from 'lucide-react';
import type { DocumentType, PaymentMethod, Sale, Settings, User } from '../../shared/types';
import { api } from '../lib/api';
import { dateTime, paymentNames, soles } from '../lib/format';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { documentNames } from '../components/Receipt';
import ReceiptDialog from '../components/pos/ReceiptDialog';
import ReportExport from '../components/ReportExport';

const selectStyle = 'h-11 w-full rounded-xl border border-border bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring';
const pageSize = 20;
const limaDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' });
const limaDate = (value: string) => {
  const parts = limaDateFormatter.formatToParts(new Date(value));
  return `${parts.find(part => part.type === 'year')?.value}-${parts.find(part => part.type === 'month')?.value}-${parts.find(part => part.type === 'day')?.value}`;
};

export default function SalesPage({ user }: { user: User }) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [document, setDocument] = useState<DocumentType | ''>('');
  const [payment, setPayment] = useState<PaymentMethod | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Sale | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true); setError('');
    try {
      const [nextSales, nextSettings] = await Promise.all([api<Sale[]>('/sales', { signal: controller.signal }), api<Settings>('/settings', { signal: controller.signal })]);
      if (!controller.signal.aborted) { setSales(nextSales); setSettings(nextSettings); }
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'No se pudo cargar el historial.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => activeRequest.current?.abort(); }, [load]);
  const invalidRange = Boolean(from && to && from > to);
  const filtered = useMemo(() => {
    if (invalidRange) return [];
    const search = query.toLocaleLowerCase('es-PE').trim();
    return sales.filter((sale) => {
      if (document && sale.documentType !== document || payment && sale.paymentMethod !== payment) return false;
      if (from || to) {
        const date = limaDate(sale.createdAt);
        if (from && date < from || to && date > to) return false;
      }
      return !search || `${sale.number} ${sale.customer?.name || 'Consumidor final'} ${sale.customer?.document || ''}`.toLocaleLowerCase('es-PE').includes(search);
    });
  }, [sales, query, document, payment, from, to, invalidRange]);
  const sum = filtered.reduce((total, sale) => total + (sale.cancelled ? 0 : sale.totalCents), 0);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const exportParams: Record<string, string> = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(query.trim() ? { query: query.trim() } : {}), ...(document ? { documentType: document } : {}), ...(payment ? { paymentMethod: payment } : {}) };
  const clearFilters = () => { setQuery(''); setFrom(''); setTo(''); setDocument(''); setPayment(''); setPage(1); };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="mb-1 text-xs font-semibold tracking-widest text-primary uppercase">Operación diaria</p><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Historial de ventas</h1><p className="mt-1 text-sm text-muted-foreground">Consulta los cobros y vuelve a imprimir sus documentos de prueba.</p></div><Button variant="outline" className="h-11" disabled={loading} onClick={() => void load()}><RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} /> Actualizar</Button></header>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="gap-0"><CardContent><div className="mb-3 flex items-center justify-between text-sm text-muted-foreground"><span>Importe registrado</span><span className="rounded-xl bg-primary/10 p-2 text-primary"><ReceiptText className="size-4" /></span></div><p className="text-3xl font-bold tracking-tight">{loading || error || invalidRange ? '—' : soles(sum)}</p><p className="mt-2 text-xs text-muted-foreground">Total filtrado, sin ventas anuladas</p></CardContent></Card>
        <Card className="gap-0"><CardContent><div className="mb-3 flex items-center justify-between text-sm text-muted-foreground"><span>Ventas encontradas</span><span className="rounded-xl bg-primary/10 p-2 text-primary"><FileText className="size-4" /></span></div><p className="text-3xl font-bold tracking-tight">{loading || error || invalidRange ? '—' : filtered.length}</p><p className="mt-2 text-xs text-muted-foreground">Todos los registros que coinciden con tus filtros</p></CardContent></Card>
        <Card className="gap-0 border border-amber-200 bg-amber-50 shadow-none"><CardContent><p className="text-sm font-semibold text-amber-900">Documentos de prueba</p><p className="mt-2 text-xs leading-relaxed text-amber-900">La emisión electrónica está deshabilitada. Ninguna venta de esta etapa se transmite a SUNAT.</p><p className="mt-3 text-xs text-amber-800">Sesión de {user.name}</p></CardContent></Card>
      </div>
      <Card className="gap-4 py-4"><CardContent className="grid items-end gap-3 px-4 sm:grid-cols-2 xl:grid-cols-[minmax(180px,1fr)_160px_160px_160px_160px]">
        <div className="relative"><Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" /><Input className="h-11 border-border bg-background pl-9" aria-label="Buscar venta por número, cliente o documento" placeholder="Número, cliente o documento…" maxLength={200} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></div>
        <select className={selectStyle} aria-label="Filtrar por documento" value={document} onChange={(event) => { setDocument(event.target.value as DocumentType | ''); setPage(1); }}><option value="">Todos los documentos</option>{Object.entries(documentNames).map(([value, name]) => <option key={value} value={value}>{name} de prueba</option>)}</select>
        <select className={selectStyle} aria-label="Filtrar por medio de pago" value={payment} onChange={(event) => { setPayment(event.target.value as PaymentMethod | ''); setPage(1); }}><option value="">Todos los pagos</option>{Object.entries(paymentNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
        <div><label htmlFor="sales-from" className="mb-1.5 block text-xs font-medium text-muted-foreground">Desde</label><div className="relative"><CalendarDays className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" /><Input id="sales-from" type="date" className="h-11 border-border bg-background pl-9" aria-label="Fecha inicial de ventas" aria-invalid={invalidRange} aria-describedby={invalidRange ? 'sales-range-error' : 'sales-range-note'} value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></div></div>
        <div><label htmlFor="sales-to" className="mb-1.5 block text-xs font-medium text-muted-foreground">Hasta</label><div className="relative"><CalendarDays className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" /><Input id="sales-to" type="date" className="h-11 border-border bg-background pl-9" aria-label="Fecha final de ventas" aria-invalid={invalidRange} aria-describedby={invalidRange ? 'sales-range-error' : 'sales-range-note'} value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></div></div>
      </CardContent><CardContent className="space-y-3 px-4"><div className="flex flex-wrap items-center justify-between gap-2"><p id="sales-range-note" className="text-xs text-muted-foreground">Ambas fechas están incluidas. Horario de Perú (Lima). Sin fechas se muestran todas las ventas.</p><Button type="button" variant="ghost" className="h-11" onClick={clearFilters}>Limpiar filtros</Button></div>{invalidRange ? <p id="sales-range-error" role="alert" className="text-sm text-destructive">La fecha inicial debe ser anterior o igual a la fecha final.</p> : null}{user.role === 'admin' ? <ReportExport endpoint="/reports/sales/export" params={exportParams} disabled={loading || Boolean(error) || invalidRange} /> : null}</CardContent></Card>
      {error ? <p role="alert" className="rounded-2xl bg-destructive/10 p-4 text-destructive">{error} <Button variant="link" onClick={() => void load()}>Reintentar</Button></p> : null}
      <Card className="gap-0 py-0">
        {loading ? <CardContent className="flex min-h-52 items-center justify-center gap-3 text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /> Cargando ventas…</CardContent> : error ? <CardContent className="py-14 text-center text-muted-foreground">El historial estará disponible cuando se complete la carga.</CardContent> : invalidRange ? <CardContent className="py-14 text-center"><CalendarDays className="mx-auto mb-4 size-10 text-muted-foreground/40" /><h2 className="font-semibold">Revisa el rango de fechas</h2><p className="mt-2 text-sm text-muted-foreground">La fecha inicial no puede ser posterior a la final.</p></CardContent> : !filtered.length ? <CardContent className="py-14 text-center"><ReceiptText className="mx-auto mb-4 size-10 text-muted-foreground/40" /><h2 className="font-semibold">{sales.length ? 'No hay ventas con estos filtros' : 'Todavía no hay ventas'}</h2><p className="mt-2 text-sm text-muted-foreground">{sales.length ? 'Cambia el rango de fechas o el término de búsqueda.' : 'Las ventas confirmadas desde el punto de venta aparecerán aquí.'}</p>{sales.length ? <Button className="mt-4 h-11" variant="outline" onClick={clearFilters}>Limpiar filtros</Button> : <Button className="mt-4 h-11" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: 'pos' }))}>Registrar una venta <ArrowUpRight className="size-4" /></Button>}</CardContent> : <>
          <div className="hidden overflow-x-auto md:block"><table className="w-full text-left text-sm"><caption className="sr-only">Ventas registradas en modo de prueba</caption><thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-5 py-4 font-medium">Documento interno</th><th className="px-5 py-4 font-medium">Fecha</th><th className="px-5 py-4 font-medium">Cliente</th><th className="px-5 py-4 font-medium">Pago</th><th className="px-5 py-4 text-right font-medium">Total</th><th className="px-5 py-4 text-right font-medium">Detalle</th></tr></thead><tbody className="divide-y divide-border">{visible.map((sale) => <tr key={sale.id} className="hover:bg-muted/30"><td className="px-5 py-4"><p className="font-semibold">{sale.number}</p><p className="mt-1 text-xs text-muted-foreground">{documentNames[sale.documentType]} · {sale.cancelled ? 'Anulada' : 'Prueba'}</p></td><td className="px-5 py-4 whitespace-nowrap"><p>{dateTime(sale.createdAt)}</p><p className="mt-1 text-xs text-muted-foreground">{sale.userName}</p></td><td className="max-w-64 px-5 py-4"><p className="truncate">{sale.customer?.name || 'Consumidor final'}</p><p className="mt-1 text-xs text-muted-foreground">{sale.customer?.document || 'Sin documento'}</p></td><td className="px-5 py-4"><span className="rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium">{paymentNames[sale.paymentMethod]}</span></td><td className="px-5 py-4 text-right font-bold whitespace-nowrap">{soles(sale.totalCents)}</td><td className="px-5 py-4 text-right"><Button className="h-11" variant="outline" onClick={() => setSelected(sale)}><ReceiptText className="size-4" /> Ver</Button></td></tr>)}</tbody></table></div>
          <div className="divide-y divide-border md:hidden">{visible.map((sale) => <div key={sale.id} className="space-y-3 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{sale.number}</p><p className="mt-1 text-xs text-muted-foreground">{documentNames[sale.documentType]} · {sale.cancelled ? 'Anulada' : 'Prueba'} · {dateTime(sale.createdAt)}</p></div><p className="font-bold">{soles(sale.totalCents)}</p></div><p className="text-sm">{sale.customer?.name || 'Consumidor final'}</p><div className="flex items-center justify-between gap-2"><span className="rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium">{paymentNames[sale.paymentMethod]}</span><Button className="h-11" variant="outline" onClick={() => setSelected(sale)}><ReceiptText className="size-4" /> Ver documento</Button></div></div>)}</div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground">{filtered.length} ventas · página {currentPage} de {pageCount}. Se exportan todos los resultados filtrados.</p>
            <div className="flex gap-2"><Button type="button" className="h-11" variant="outline" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Anterior</Button><Button type="button" className="h-11" variant="outline" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>Siguiente</Button></div>
          </div>
        </>}
      </Card>
      <ReceiptDialog sale={selected} settings={settings} onClose={() => setSelected(null)} />
    </div>
  );
}
