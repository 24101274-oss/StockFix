import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Presentation, Product, ProductInput } from '../../../shared/types';
import { patch, post } from '../../lib/api';
import { cents } from '../../lib/format';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { actionClass, controlClass, ErrorMessage, Field, ManagementDialog, messageOf } from './common';

type PresentationDraft = Omit<Presentation, 'priceCents'> & { price: string; minimum: string };
export default function ProductEditor({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: (product: Product) => void }) {
  const [name, setName] = useState(product?.name ?? '');
  const [brand, setBrand] = useState(product?.brand ?? '');
  const [category, setCategory] = useState(product?.category ?? 'General');
  const [barcode, setBarcode] = useState(product?.barcode ?? '');
  const [active, setActive] = useState(product?.active ?? true);
  const [looseMinimum, setLooseMinimum] = useState(() => {
    const minimum = product?.minStockByPresentation?.find(item => item.presentationId === null)?.minimum;
    return minimum == null ? '' : String(minimum);
  });
  const [presentations, setPresentations] = useState<PresentationDraft[]>(() => (product?.presentations ?? []).map((p) => {
    const minimum = product?.minStockByPresentation?.find(item => item.presentationId === p.id)?.minimum;
    return { ...p, price: (p.priceCents / 100).toFixed(2), minimum: minimum == null ? '' : String(minimum) };
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const updatePresentation = (index: number, changes: Partial<PresentationDraft>) => setPresentations((items) => items.map((item, i) => i === index ? { ...item, ...changes } : item));
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    if (presentations.some((p) => !p.label.trim() || !Number.isInteger(p.units) || p.units <= 0 || !p.price.trim() || !Number.isFinite(Number(p.price)) || cents(p.price) <= 0)) { setError('Cada presentación necesita un nombre, una cantidad entera de piezas mayor que cero y un precio de venta positivo.'); return; }
    const minimumDrafts = [
      ...presentations.filter(p => p.units > 1).map(p => ({ presentationId: p.id as string | null, value: p.minimum })),
      { presentationId: null, value: looseMinimum },
    ].filter(item => item.value.trim() !== '');
    if (minimumDrafts.some(item => !Number.isSafeInteger(Number(item.value)) || Number(item.value) < 0 || Number(item.value) > 1_000_000_000)) { setError('Cada mínimo debe ser una cantidad entera de presentaciones entre 0 y 1.000.000.000. Déjalo vacío para desactivar esa alerta.'); return; }
    const minStockByPresentation = minimumDrafts.map(item => ({ presentationId: item.presentationId, minimum: Number(item.value) }));
    setBusy(true);
    const input: ProductInput = { name: name.trim(), brand: brand.trim(), category: category.trim(), barcode: barcode.trim() || null, active, minStockUnits: null, minStockByPresentation, presentations: presentations.map((p) => ({ id: p.id, label: p.label.trim(), units: p.units, priceCents: cents(p.price) })) };
    try { onSaved(product ? await patch<Product>(`/products/${product.id}`, input) : await post<Product>('/products', input)); }
    catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <ManagementDialog open onClose={onClose} title={product ? 'Editar producto' : 'Nuevo producto'} detail="Configura el contenido, precio y mínimo de cada presentación." wide busy={busy}>
    <form onSubmit={save} className="space-y-5"><ErrorMessage message={error} />
      <fieldset disabled={busy} className="space-y-5">
        {product ? <p className="rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">Código interno: <strong className="text-foreground">{product.sku}</strong></p> : null}
        <Field label="Nombre del producto"><Input className={controlClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></Field>
        <div className="grid gap-4 sm:grid-cols-2"><Field label="Marca"><Input className={controlClass} value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} /></Field><Field label="Categoría"><Input className={controlClass} value={category} onChange={(e) => setCategory(e.target.value)} required maxLength={80} /></Field></div>
        <Field label="Código de barras o QR" hint="Enfoca este campo y escanea el código del producto. También puedes escribirlo."><Input className={controlClass} value={barcode} onChange={(e) => setBarcode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} maxLength={200} /></Field>
        {product?.minStockUnits != null && product.minStockByPresentation === undefined ? <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Este producto tenía un mínimo general de {product.minStockUnits.toLocaleString('es-PE')} unidades. Configura abajo los mínimos de sus presentaciones; ese total no determina cuántos empaques tienes.</p> : null}
        <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Presentaciones de venta</h3><Button type="button" variant="outline" className={actionClass} disabled={presentations.length >= 20} onClick={() => setPresentations((items) => [...items, { id: crypto.randomUUID(), label: '', units: 1, price: '', minimum: '' }])}><Plus />Añadir presentación</Button></div>
          <p className="text-xs leading-relaxed text-muted-foreground">Ejemplo confirmado: un paquete de 100 bolsas contiene 100 piezas; un fardo de 50 paquetes contiene 5.000 piezas. Configura cada producto por separado.</p>
          {presentations.length === 0 ? <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Este producto quedará pendiente de configurar y no estará disponible para vender.</p> : presentations.map((p, index) => <div key={p.id} className="grid items-end gap-3 rounded-xl border border-border p-3 sm:grid-cols-[1.3fr_1fr_1fr_auto]">
            <Field label="Presentación"><Input className={controlClass} value={p.label} placeholder="Paquete de 100" onChange={(e) => updatePresentation(index, { label: e.target.value })} required maxLength={80} /></Field>
            <Field label="Unidades que contiene" hint="Contenido de una presentación; no es el stock disponible."><Input className={controlClass} type="number" min="1" max="1000000" step="1" value={Number.isNaN(p.units) ? '' : p.units} onChange={(e) => updatePresentation(index, { units: e.target.value === '' ? NaN : Number(e.target.value) })} required /></Field>
            <Field label="Precio de esta presentación (S/)"><Input className={controlClass} type="number" min="0.01" step="0.01" value={p.price} onChange={(e) => updatePresentation(index, { price: e.target.value })} required /></Field>
            <Button type="button" variant="outline" className="min-h-11 px-3" aria-label={`Quitar presentación ${p.label || index + 1}`} onClick={() => setPresentations((items) => items.filter((_, i) => i !== index))}><Trash2 /></Button>
            {p.units > 1 ? <div className="sm:col-span-4"><Field label={`Mínimo de stock · ${p.label || 'presentación ' + (index + 1)}`} hint="Cantidad de esta presentación en cada ubicación. Vacío desactiva la alerta; 0 avisa solo cuando se agote."><Input className={controlClass} type="number" inputMode="numeric" min="0" max="1000000000" step="1" placeholder="Sin mínimo configurado" aria-label={`Mínimo de stock de ${p.label || 'presentación ' + (index + 1)}`} value={p.minimum} onChange={event => updatePresentation(index, { minimum: event.target.value })} /></Field></div> : <p className="text-xs text-muted-foreground sm:col-span-4">Esta presentación utiliza el saldo y el mínimo de unidades sueltas.</p>}
          </div>)}
        </div>
        <Field label="Mínimo de stock · Unidades sueltas" hint="Incluye las presentaciones de una unidad. Se aplica por separado en puesto y almacén. Vacío desactiva la alerta; 0 avisa solo cuando se agoten."><Input className={controlClass} type="number" inputMode="numeric" min="0" max="1000000000" step="1" placeholder="Sin mínimo configurado" aria-label="Mínimo de stock de Unidades sueltas" value={looseMinimum} onChange={event => setLooseMinimum(event.target.value)} /></Field>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm" style={{ flexDirection: 'row' }}><input type="checkbox" className="size-5 accent-primary" checked={active} onChange={(e) => setActive(e.target.checked)} />Producto activo</label>
        {product?.sourceNotes.length ? <details className="rounded-xl bg-muted p-3"><summary className="cursor-pointer text-sm font-medium">Datos del Excel original</summary><ul className="mt-3 space-y-1 text-xs leading-relaxed text-muted-foreground">{product.sourceNotes.map((note, i) => <li key={i}>{note}</li>)}</ul></details> : null}
      </fieldset>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" className={actionClass} onClick={onClose} disabled={busy}>Cancelar</Button><Button type="submit" className={actionClass} disabled={busy}>{busy ? 'Guardando…' : 'Guardar producto'}</Button></div>
    </form>
  </ManagementDialog>;
}
