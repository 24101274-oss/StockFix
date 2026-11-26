import { useEffect, useState, type FormEvent } from 'react';
import { BarChart3, CircleHelp, RefreshCw, TrendingUp } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { FORECAST_METHOD_LABELS, type ForecastLocation, type ForecastQuery, type ForecastReport, type ForecastSeries } from '../../shared/forecast';
import type { Product } from '../../shared/types';
import { api } from '../lib/api';
import { ErrorNotice, Loading } from '../components/State';
import ReportExport from '../components/ReportExport';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader } from '../components/ui/card';
import { Input } from '../components/ui/input';

const number = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 });
const monthLabel = (month: string) => new Intl.DateTimeFormat('es-PE', { month: 'short', year: 'numeric', timeZone: 'America/Lima' }).format(new Date(`${month}-01T12:00:00-05:00`));
const selectStyle = 'h-11 w-full rounded-xl border border-border bg-background px-3 text-sm';
function todayLima() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}-${parts.find(p => p.type === 'day')?.value}`;
}
function queryParams(query: ForecastQuery): Record<string, string> {
  return { cutoff: query.cutoff, horizon: String(query.horizon), location: query.location, ...(query.productId ? { productId: query.productId } : {}) };
}

function SeriesDetail({ series }: { series: ForecastSeries }) {
  const data = [
    ...series.history.slice(-12).map(point => ({ month: point.month, observed: point.physicalUnits, partial: null as number | null, predicted: null as number | null })),
    ...(series.partial ? [{ month: series.partial.month, observed: null, partial: series.partial.physicalUnits, predicted: null }] : []),
    ...series.forecast.map(point => ({ month: point.month, observed: null, partial: null, predicted: point.physicalUnits })),
  ];
  const evaluation = series.evaluation;
  return <Card>
    <CardHeader><h2 className="text-base font-semibold">{series.productName} · {series.presentationLabel}</h2><p className="text-sm text-muted-foreground">Cada punto representa piezas físicas vendidas en esta presentación. Los meses anteriores al inicio del registro no se completan con ceros.</p></CardHeader>
    <CardContent className="space-y-4">
      {data.length ? <div className="h-72 w-full" role="img" aria-label={`Histórico y pronóstico en piezas de ${series.productName}, ${series.presentationLabel}. ${series.history.length} meses completos. ${series.forecast.map(point => `${monthLabel(point.month)}: ${point.physicalUnits} piezas estimadas`).join('; ')}`}>
        <ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{ left: 0, right: 14, top: 15, bottom: 0 }}><CartesianGrid strokeDasharray="4 4" vertical={false} stroke="var(--border)" /><XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 11 }} minTickGap={24} /><YAxis width={54} tick={{ fontSize: 11 }} allowDecimals={false} /><Tooltip labelFormatter={label => monthLabel(String(label))} formatter={(value, name) => [`${number.format(Number(value))} piezas`, name]} contentStyle={{ borderRadius: 12, borderColor: 'var(--border)' }} /><Legend /><Line name="Vendido (mes completo)" dataKey="observed" stroke="var(--primary)" strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={false} /><Line name="Mes parcial, fuera del entrenamiento" dataKey="partial" stroke="#b45309" dot={{ r: 5 }} isAnimationActive={false} /><Line name="Pronóstico" dataKey="predicted" stroke="#7c3aed" strokeWidth={2.5} strokeDasharray="5 4" dot={{ r: 4 }} isAnimationActive={false} /></LineChart></ResponsiveContainer>
      </div> : <p className="py-8 text-center text-muted-foreground">Todavía no hay meses completos registrados para esta presentación.</p>}
      <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Historial utilizado</p><p className="mt-1 font-semibold">{series.history.length} meses completos</p><p className="mt-1 text-xs text-muted-foreground">{series.history.length ? `${monthLabel(series.history[0].month)} – ${monthLabel(series.history.at(-1)!.month)}` : 'Sin cobertura suficiente'}</p></div><div className="rounded-xl bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Método seleccionado</p><p className="mt-1 font-semibold">{series.method ? FORECAST_METHOD_LABELS[series.method] : 'Pendiente de historial'}</p><p className="mt-1 text-xs text-muted-foreground">{evaluation ? 'Menor MAE en tres cortes temporales' : 'Sin evaluación suficiente para comparar métodos'}</p></div><div className="rounded-xl bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Error absoluto medio (MAE)</p><p className="mt-1 font-semibold">{evaluation ? `${number.format(evaluation.mae)} piezas` : 'No disponible'}</p><p className="mt-1 text-xs text-muted-foreground">{evaluation ? `Sesgo: ${number.format(evaluation.bias)} piezas (positivo = sobreestimación)` : 'Se requieren al menos 6 meses completos'}</p></div></div>
      {evaluation ? <details className="rounded-xl border border-border p-3 text-sm"><summary className="cursor-pointer font-semibold">Ver comparación de métodos</summary><p className="mt-3 text-xs text-muted-foreground">Evaluación de un mes por corte, entrenando solo con meses anteriores: {evaluation.months.map(monthLabel).join(', ')}. Es un error histórico; no garantiza el resultado futuro.</p><div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Comparación temporal de métodos de predicción</caption><thead><tr className="border-b border-border"><th className="py-2 pr-3">Método</th><th className="py-2 text-right">MAE (piezas)</th><th className="py-2 text-right">Sesgo (piezas)</th></tr></thead><tbody>{evaluation.candidates.map(candidate => <tr key={candidate.method} className="border-b border-border/50"><td className="py-2 pr-3">{FORECAST_METHOD_LABELS[candidate.method]}{candidate.method === series.method ? ' · seleccionado' : ''}</td><td className="py-2 text-right">{number.format(candidate.mae)}</td><td className="py-2 text-right">{number.format(candidate.bias)}</td></tr>)}</tbody></table></div></details> : null}
      {series.warnings.length ? <ul className="list-disc space-y-1 rounded-xl bg-amber-50 p-4 pl-8 text-sm text-amber-950">{series.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
    </CardContent>
  </Card>;
}

export default function ForecastPage() {
  const [today] = useState(todayLima);
  const [draft, setDraft] = useState<ForecastQuery>(() => ({ cutoff: today, horizon: 3, location: 'all' }));
  const [request, setRequest] = useState(() => ({ query: draft, revision: 0 }));
  const [products, setProducts] = useState<Product[]>([]);
  const [report, setReport] = useState<ForecastReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError('');
    Promise.all([
      api<ForecastReport>(`/forecast?${new URLSearchParams(queryParams(request.query))}`, { signal: controller.signal }),
      api<Product[]>('/products', { signal: controller.signal }),
    ]).then(([result, catalog]) => { if (!controller.signal.aborted) { setReport(result); setProducts(catalog.filter(product => product.active)); } })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'No se pudo calcular el pronóstico.'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [request]);
  function calculate(event: FormEvent) { event.preventDefault(); setRequest(current => ({ query: { ...draft }, revision: current.revision + 1 })); }
  const selected = report?.series.find(series => series.id === selectedId) ?? report?.series[0];
  const months = report?.series.find(series => series.forecast.length)?.forecast.map(point => point.month) ?? [];
  const ready = report?.series.filter(series => series.status === 'ready').length ?? 0;
  return <div className="space-y-5">
    <header><p className="mb-1 text-xs font-semibold tracking-widest text-primary uppercase">Planificación del negocio</p><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Predicción mensual</h1><p className="mt-2 max-w-3xl text-sm text-muted-foreground">Estima ventas futuras por producto y presentación. Compara métodos estadísticos con los meses anteriores y consulta sus límites antes de decidir.</p></header>
    <Card><CardContent><form onSubmit={calculate} className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[160px_130px_160px_minmax(180px,1fr)_auto]">
      <label className="space-y-1.5 text-xs font-medium">Ventas conocidas hasta<Input className="h-11" type="date" required max={today} value={draft.cutoff} onChange={event => setDraft(current => ({ ...current, cutoff: event.target.value }))} /></label>
      <label className="space-y-1.5 text-xs font-medium">Meses a predecir<select aria-label="Meses a predecir" className={selectStyle} value={draft.horizon} onChange={event => setDraft(current => ({ ...current, horizon: Number(event.target.value) }))}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} {i ? 'meses' : 'mes'}</option>)}</select></label>
      <label className="space-y-1.5 text-xs font-medium">Ubicación<select aria-label="Ubicación" className={selectStyle} value={draft.location} onChange={event => setDraft(current => ({ ...current, location: event.target.value as ForecastLocation }))}><option value="all">Ambas ubicaciones</option><option value="puesto">Puesto</option><option value="almacen">Almacén</option></select></label>
      <label className="space-y-1.5 text-xs font-medium">Producto<select aria-label="Producto" className={selectStyle} value={draft.productId ?? ''} onChange={event => setDraft(current => ({ ...current, productId: event.target.value || undefined }))}><option value="">Todos los productos activos</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
      <Button type="submit" className="h-11" disabled={busy}><RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} />{busy ? 'Calculando…' : 'Calcular pronóstico'}</Button>
    </form><p className="mt-3 text-xs text-muted-foreground">Horario de Lima. El mes de corte está incompleto y se muestra por separado. Las proyecciones empiezan el mes siguiente.</p></CardContent></Card>
    {busy ? <div role="status"><Loading /></div> : error ? <div className="space-y-3"><ErrorNotice message={error} /><Button variant="outline" className="h-11" onClick={() => setRequest(current => ({ ...current, revision: current.revision + 1 }))}>Reintentar cálculo</Button></div> : report ? <>
      <div className="grid gap-4 sm:grid-cols-3"><Card><CardContent><p className="flex items-center gap-2 text-sm text-muted-foreground"><BarChart3 className="size-4" /> Series con pronóstico</p><p className="mt-2 text-3xl font-bold">{ready} <span className="text-base font-normal text-muted-foreground">de {report.series.length}</span></p><p className="mt-2 text-xs text-muted-foreground">Cada producto y presentación se evalúa por separado.</p></CardContent></Card><Card><CardContent><p className="text-sm text-muted-foreground">Origen del histórico</p><p className="mt-2 font-semibold">{report.source.label}</p><p className="mt-2 text-xs text-muted-foreground">Corte aplicado: {report.query.cutoff}. {report.source.observedThrough ? `Cobertura declarada hasta ${report.source.observedThrough}.` : 'Cobertura inferida de los registros.'}</p></CardContent></Card><Card><CardContent><p className="flex items-center gap-2 text-sm font-semibold"><CircleHelp className="size-4" /> Apoyo a la decisión</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">La estimación usa ventas registradas. La falta de stock puede ocultar demanda. Este cálculo no registra compras ni cambia el inventario.</p></CardContent></Card></div>
      {report.warnings.length ? <ul className="list-disc space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-4 pl-8 text-sm text-amber-950">{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
      {report.series.length ? <>
        <div className="flex flex-wrap items-end justify-between gap-3"><label className="min-w-0 flex-1 space-y-1.5 text-sm font-medium sm:max-w-xl">Serie para revisar<select aria-label="Serie para revisar" className={selectStyle} value={selected?.id ?? ''} onChange={event => setSelectedId(event.target.value)}>{report.series.map(series => <option key={series.id} value={series.id}>{series.productName} · {series.presentationLabel}</option>)}</select></label><ReportExport endpoint="/forecast/export" params={queryParams(report.query)} /></div>
        {selected ? <SeriesDetail series={selected} /> : null}
        <Card className="gap-0"><CardHeader className="pb-4"><h2 className="text-base font-semibold">Estimación por presentación</h2><p className="text-sm text-muted-foreground">La cantidad de presentaciones se redondea hacia arriba usando su tamaño actual. Debajo se muestra la estimación original en piezas. No suma productos diferentes.</p></CardHeader><div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Pronósticos de ventas por producto, presentación y mes</caption><thead className="border-y border-border bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-5 py-3">Producto / presentación</th>{months.map(month => <th key={month} className="px-5 py-3 text-right whitespace-nowrap">{monthLabel(month)}</th>)}<th className="px-5 py-3">Método / MAE</th></tr></thead><tbody className="divide-y divide-border">{report.series.map(series => <tr key={series.id} className={selected?.id === series.id ? 'bg-primary/5' : ''}><th scope="row" className="px-5 py-3 text-left font-normal"><button type="button" className="text-left font-semibold text-primary underline-offset-4 hover:underline" onClick={() => setSelectedId(series.id)}>{series.productName}</button><p className="mt-1 text-xs text-muted-foreground">{series.presentationLabel} · {number.format(series.unitsPerPresentation)} piezas por presentación</p></th>{months.map(month => { const point = series.forecast.find(point => point.month === month); return <td key={month} className="px-5 py-3 text-right whitespace-nowrap">{point ? <><span className="font-bold">{number.format(point.presentationQuantity)}</span><span className="mt-1 block text-xs text-muted-foreground">{number.format(point.physicalUnits)} piezas</span></> : <span className="text-muted-foreground">Sin historial suficiente</span>}</td>; })}<td className="px-5 py-3 text-xs">{series.method ? FORECAST_METHOD_LABELS[series.method] : 'Pendiente'}<p className="mt-1 text-muted-foreground">{series.evaluation ? `MAE: ${number.format(series.evaluation.mae)} piezas` : 'MAE no disponible'}</p></td></tr>)}</tbody></table></div></Card>
      </> : <Card><CardContent className="py-10 text-center"><TrendingUp className="mx-auto mb-3 size-8 text-muted-foreground/40" /><h2 className="font-semibold">No hay productos activos para predecir</h2><p className="mt-2 text-sm text-muted-foreground">Completa el catálogo y registra un historial de ventas antes de calcular.</p></CardContent></Card>}
      <p className="text-xs leading-relaxed text-muted-foreground">{report.methodology}</p>
    </> : null}
  </div>;
}
