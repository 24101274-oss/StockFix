import { useEffect, useState } from 'react';
import { ArrowRight, Banknote, Boxes, CircleAlert, PackageCheck, ShoppingBag, TrendingUp } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Sale, Summary } from '../../shared/types';
import { api } from '../lib/api';
import { dateTime, paymentNames, soles } from '../lib/format';
import { ErrorNotice, Loading } from '../components/State';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader } from '../components/ui/card';
import StockAlertGroups from '../components/StockAlertGroups';

function navigate(page: string) { window.dispatchEvent(new CustomEvent('navigate', { detail: page })); }
const units = new Intl.NumberFormat('es-PE');
const monthName = (month: string) => new Intl.DateTimeFormat('es-PE', { month: 'long', year: 'numeric', timeZone: 'America/Lima' }).format(new Date(`${month}-01T12:00:00-05:00`));

export default function DashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    Promise.all([api<Summary>('/summary', { signal: controller.signal }), api<Sale[]>('/sales', { signal: controller.signal })])
      .then(([data, list]) => { if (!controller.signal.aborted) { setSummary(data); setSales(list); } })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'No se pudo cargar el resumen.'); });
    return () => controller.abort();
  }, [reload]);
  if (error) return <div className="space-y-3"><ErrorNotice message={error} /><Button className="h-11" variant="outline" onClick={() => setReload(value => value + 1)}>Reintentar</Button></div>;
  if (!summary) return <Loading />;

  const month = monthName(summary.month);
  const cards = [
    { label: 'Ingresos por ventas del mes', value: soles(summary.monthSalesCents), sub: `${summary.monthSalesCount} ventas · ${month}`, icon: TrendingUp },
    { label: 'Ventas de hoy', value: soles(summary.todaySalesCents), sub: `${summary.todaySalesCount} operaciones registradas`, icon: Banknote },
    { label: 'Productos en catálogo', value: String(summary.productsCount), sub: `${summary.pendingProductsCount} por completar`, icon: Boxes },
    { label: 'Productos con stock bajo', value: String(summary.lowStockCount), sub: 'Productos únicos entre puesto y almacén', icon: CircleAlert },
    { label: 'Caja del negocio', value: summary.cashOpen ? 'Abierta' : 'Cerrada', sub: 'Efectivo y pagos digitales separados', icon: ShoppingBag },
    { label: 'Ganancias del negocio', value: 'Pendientes', sub: 'Requieren costos de compra completos', icon: PackageCheck },
  ];
  const maxTopAmount = Math.max(1, ...summary.topProducts.map(product => product.totalCents));

  return <div className="space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="mb-1 text-xs font-semibold tracking-widest text-primary uppercase">Mi negocio</p><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Resumen del negocio</h1><p className="mt-1 text-sm text-muted-foreground">Ventas de {month}, inventario y estado de caja.</p></div><Button className="h-11" onClick={() => navigate('pos')}><ShoppingBag className="size-4" /> Nueva venta</Button></header>

    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{cards.map(({ label, value, sub, icon: Icon }) => <Card key={label} className="gap-0"><CardContent><div className="mb-3 flex items-center justify-between gap-3 text-sm text-muted-foreground"><span>{label}</span><span className="rounded-xl bg-primary/10 p-2 text-primary"><Icon className="size-5" /></span></div><p className="text-3xl font-bold tracking-tight">{value}</p><p className="mt-2 text-xs text-muted-foreground">{sub}</p></CardContent></Card>)}</div>

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card className="gap-4"><CardHeader><h2 className="text-base font-semibold">Ventas de los últimos 7 días</h2><p className="text-sm text-muted-foreground">Importes finales en soles. Las ventas anuladas se excluyen.</p></CardHeader><CardContent><div className="h-64 w-full" role="img" aria-label={`Ventas de los últimos siete días: ${summary.week.map(day => `${day.date}: ${soles(day.totalCents)}`).join('; ')}`}><ResponsiveContainer width="100%" height="100%"><AreaChart data={summary.week.map(day => ({ ...day, amount: day.totalCents / 100 }))} margin={{ left: 0, right: 12, top: 15, bottom: 0 }}><defs><linearGradient id="salesGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity={0.2} /><stop offset="95%" stopColor="var(--primary)" stopOpacity={0} /></linearGradient></defs><CartesianGrid strokeDasharray="4 4" vertical={false} stroke="var(--border)" /><XAxis dataKey="date" tickFormatter={date => String(date).slice(5).replace('-', '/')} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} /><YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} width={48} /><Tooltip formatter={value => [soles(Number(value) * 100), 'Ventas']} contentStyle={{ borderRadius: 12, borderColor: 'var(--border)', background: 'var(--card)' }} /><Area type="monotone" dataKey="amount" stroke="var(--primary)" strokeWidth={2.5} fill="url(#salesGradient)" /></AreaChart></ResponsiveContainer></div>{summary.week.every(day => day.totalCents === 0) ? <p className="mt-3 text-sm text-muted-foreground">Todavía no hay ventas en estos siete días.</p> : null}</CardContent></Card>

      <Card className="gap-4"><CardHeader><h2 className="text-base font-semibold">Más vendidos por importe del mes</h2><p className="text-sm text-muted-foreground">{month} · importes de ventas, no ganancias.</p></CardHeader><CardContent>{summary.topProducts.length ? <ol className="space-y-4">{summary.topProducts.map((product, index) => <li key={product.productId}><div className="mb-1 flex items-start justify-between gap-3"><p className="min-w-0 text-sm font-medium"><span className="mr-2 text-muted-foreground">{index + 1}.</span>{product.name}</p><span className="shrink-0 text-sm font-bold">{soles(product.totalCents)}</span></div><p className="mb-2 text-xs text-muted-foreground">{units.format(product.quantityUnits)} unidades base · {product.salesCount} ventas</p><div className="h-2 overflow-hidden rounded-full bg-primary/10" aria-hidden="true"><div className="h-full rounded-full bg-primary" style={{ width: `${product.totalCents / maxTopAmount * 100}%` }} /></div></li>)}</ol> : <div className="py-8 text-center"><TrendingUp className="mx-auto mb-3 size-8 text-muted-foreground/40" /><h3 className="font-semibold">Aún no hay un ranking este mes</h3><p className="mt-2 text-sm text-muted-foreground">Aparecerá con las ventas registradas durante {month}.</p></div>}</CardContent></Card>
    </div>

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card className="gap-4"><CardHeader className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold">Alertas de stock por presentación</h2><p className="mt-1 text-sm text-muted-foreground">Un bloque por producto, con cada presentación y ubicación que alcanzó su mínimo.</p></div><Button className="h-11" variant="outline" onClick={() => navigate('inventory')}>Ver inventario <ArrowRight className="size-4" /></Button></CardHeader><CardContent>{summary.lowStock.length ? <StockAlertGroups products={summary.lowStock} /> : <div className="py-8 text-center"><PackageCheck className="mx-auto mb-3 size-8 text-muted-foreground/40" /><h3 className="font-semibold">No hay alertas de stock</h3><p className="mt-2 text-sm text-muted-foreground">Configura mínimos por presentación y completa su conteo en cada ubicación.</p></div>}</CardContent></Card>

      <Card className="gap-4"><CardHeader><h2 className="text-base font-semibold">Para continuar</h2><p className="text-sm text-muted-foreground">Lo que necesita atención</p></CardHeader><CardContent className="space-y-3"><Button className="h-auto min-h-11 w-full justify-between gap-3 px-3 py-3 text-left whitespace-normal" variant="outline" onClick={() => navigate('inventory')}><Boxes className="size-5 text-primary" /><span className="flex-1"><span className="block font-semibold">Completar el inventario</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{summary.pendingProductsCount} productos por revisar</span></span><ArrowRight className="size-4" /></Button><Button className="h-auto min-h-11 w-full justify-between gap-3 px-3 py-3 text-left whitespace-normal" variant="outline" onClick={() => navigate('cash')}><Banknote className="size-5 text-primary" /><span className="flex-1"><span className="block font-semibold">{summary.cashOpen ? 'Revisar caja' : 'Abrir caja'}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{summary.cashOpen ? 'Consulta el efectivo esperado' : 'Ingresa el fondo inicial para vender'}</span></span><ArrowRight className="size-4" /></Button><div className="rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-sm font-semibold text-amber-900">Facturación en pruebas</p><p className="mt-1 text-xs leading-relaxed text-amber-900">La emisión electrónica está deshabilitada. Los documentos actuales no tienen validez tributaria.</p></div></CardContent></Card>
    </div>

    <Card className="gap-4"><CardHeader className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold">Últimas ventas</h2><p className="mt-1 text-sm text-muted-foreground">Las cinco operaciones más recientes</p></div><Button className="h-11" variant="outline" onClick={() => navigate('sales')}>Ver historial <ArrowRight className="size-4" /></Button></CardHeader>{sales.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Cinco ventas recientes del negocio</caption><thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Documento interno</th><th className="px-5 py-3 font-medium">Cliente</th><th className="px-5 py-3 font-medium">Fecha</th><th className="px-5 py-3 font-medium">Pago</th><th className="px-5 py-3 text-right font-medium">Total</th><th className="px-5 py-3 font-medium">Estado</th></tr></thead><tbody className="divide-y divide-border">{sales.slice(0, 5).map(sale => <tr key={sale.id}><td className="px-5 py-3 font-semibold whitespace-nowrap">{sale.number}</td><td className="px-5 py-3">{sale.customer?.name ?? 'Consumidor final'}</td><td className="px-5 py-3 whitespace-nowrap">{dateTime(sale.createdAt)}</td><td className="px-5 py-3">{paymentNames[sale.paymentMethod]}</td><td className="px-5 py-3 text-right font-semibold whitespace-nowrap">{soles(sale.totalCents)}</td><td className="px-5 py-3"><span className="badge-warning">{sale.cancelled ? 'Anulada' : 'Prueba'}</span></td></tr>)}</tbody></table></div> : <CardContent className="py-8 text-center"><ShoppingBag className="mx-auto mb-3 size-8 text-muted-foreground/40" /><h3 className="font-semibold">Todavía no hay ventas</h3><p className="mt-2 text-sm text-muted-foreground">Abre caja y registra una operación para comenzar.</p></CardContent>}</Card>
  </div>;
}
