import { useRef, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import type { Supplier, SupplierInput } from '../../../shared/types';
import { ApiError, post } from '../../lib/api';
import { documentLookupAvailability, documentLookupFallback, documentLookupNotice, documentLookupValidation, useDocumentLookup } from '../../lib/document-lookup';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { actionClass, controlClass, ErrorMessage, Field, ManagementDialog, messageOf } from './common';

export default function SupplierEditor({ onClose, onSaved, initial }: { onClose: () => void; onSaved: (supplier: Supplier) => void; initial?: Partial<SupplierInput> }) {
  const [form, setForm] = useState<SupplierInput>({ ruc: '', name: '', address: '', phone: '', ...initial });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const lookup = useDocumentLookup();
  const formRef = useRef(form);
  function updateForm(next: SupplierInput) { formRef.current = next; setForm(next); }
  function close() { lookup.cancel(); onClose(); }
  async function consult() {
    setError(''); setNotice('');
    const ruc = form.ruc;
    const validation = documentLookupValidation('RUC', ruc);
    if (validation) { setError(validation); return; }
    try {
      const result = await lookup.query('RUC', ruc);
      if (!result || formRef.current.ruc !== ruc) return;
      updateForm({ ...formRef.current, name: result.name, address: result.address || '' });
      setNotice(documentLookupNotice(result));
    } catch (error) {
      if (formRef.current.ruc === ruc) setNotice(documentLookupFallback(error));
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saveBusy || lookup.busy) return;
    const validation = documentLookupValidation('RUC', form.ruc);
    if (validation) { setError(validation); return; }
    if (!form.name.trim()) { setError('Ingresa la razón social del proveedor.'); return; }
    setError(''); setSaveBusy(true);
    try { onSaved(await post<Supplier>('/suppliers', { ...form, name: form.name.trim(), address: form.address.trim(), phone: form.phone.trim() })); }
    catch (error) { setError(error instanceof ApiError && error.status === 409 ? error.message + ' Selecciona el proveedor existente en la lista.' : messageOf(error)); }
    finally { setSaveBusy(false); }
  }
  const blocked = saveBusy || lookup.busy;
  return <ManagementDialog open onClose={close} title="Nuevo proveedor" detail={documentLookupAvailability(lookup.status, 'RUC')} busy={saveBusy}><form onSubmit={save} className="space-y-5"><ErrorMessage message={error} />{notice ? <p role="status" className="rounded-xl bg-muted p-3 text-sm leading-relaxed text-muted-foreground">{notice}</p> : null}<fieldset disabled={blocked} className="space-y-4"><Field label="RUC"><div className="flex gap-2"><Input className={controlClass} inputMode="numeric" pattern="[0-9]{11}" maxLength={11} value={form.ruc} onChange={(event) => { lookup.cancel(); updateForm({ ruc: event.target.value.replace(/\D/g, ''), name: '', address: '', phone: '' }); setNotice(''); setError(''); }} required placeholder="11 dígitos" /><Button type="button" variant="outline" className={actionClass} onClick={() => void consult()}><Search />{lookup.busy ? 'Consultando…' : 'Consultar RUC'}</Button></div></Field><Field label="Razón social"><Input className={controlClass} value={form.name} onChange={(event) => updateForm({ ...form, name: event.target.value })} maxLength={200} required /></Field><Field label="Dirección"><Input className={controlClass} value={form.address} onChange={(event) => updateForm({ ...form, address: event.target.value })} maxLength={500} /></Field><Field label="Teléfono (opcional)"><Input className={controlClass} type="tel" value={form.phone} onChange={(event) => updateForm({ ...form, phone: event.target.value })} maxLength={30} /></Field></fieldset><div className="flex justify-end gap-2"><Button type="button" variant="outline" className={actionClass} disabled={saveBusy} onClick={close}>Cancelar</Button><Button type="submit" className={actionClass} disabled={blocked}>{saveBusy ? 'Guardando…' : 'Guardar proveedor'}</Button></div></form></ManagementDialog>;
}
