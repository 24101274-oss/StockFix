import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, Search } from 'lucide-react';
import type { Customer, CustomerInput } from '../../../shared/types';
import { ApiError, post } from '../../lib/api';
import { documentLookupAvailability, documentLookupFallback, documentLookupNotice, documentLookupValidation, useDocumentLookup } from '../../lib/document-lookup';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';

const emptyCustomer = (type: 'DNI' | 'RUC'): CustomerInput => ({ documentType: type, document: '', name: '', address: '' });
export default function CustomerDialog({ open, onOpenChange, onSaved, initialType = 'DNI', selectExistingAutomatically = true }: {
  open: boolean; onOpenChange: (open: boolean) => void; onSaved: (customer: Customer) => void;
  initialType?: 'DNI' | 'RUC'; selectExistingAutomatically?: boolean;
}) {
  const [form, setForm] = useState<CustomerInput>(() => emptyCustomer(initialType));
  const [saveBusy, setSaveBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [existing, setExisting] = useState<Customer | null>(null);
  const lookup = useDocumentLookup();
  const openRef = useRef(open);
  const formRef = useRef(form);
  openRef.current = open;
  function updateForm(next: CustomerInput) { formRef.current = next; setForm(next); }
  function close() { lookup.cancel(); openRef.current = false; setExisting(null); onOpenChange(false); }

  useEffect(() => {
    lookup.cancel();
    const next = emptyCustomer(initialType);
    formRef.current = next; setForm(next); setExisting(null); setError(''); setNotice('');
  }, [open, initialType, lookup.cancel]);

  function changeDocument(next: CustomerInput) {
    lookup.cancel(); setError(''); setNotice(''); setExisting(null);
    updateForm({ ...next, name: '', address: '' });
  }
  async function consult() {
    const type = form.documentType;
    if (type === 'SIN_DOCUMENTO') return;
    const document = form.document;
    const validation = documentLookupValidation(type, document);
    if (validation) { setError(validation); return; }
    setError(''); setNotice(''); setExisting(null);
    try {
      const result = await lookup.query(type, document);
      if (!result || !openRef.current || formRef.current.documentType !== type || formRef.current.document !== document) return;
      if (result.customer) {
        if (selectExistingAutomatically) { onSaved(result.customer); close(); return; }
        setExisting(result.customer);
      }
      updateForm({ ...formRef.current, name: result.name, address: result.address || '' });
      setNotice(documentLookupNotice(result) + (result.customer ? ' Este cliente ya está registrado; úsalo sin crear otro registro.' : ''));
    } catch (error) {
      if (openRef.current && formRef.current.documentType === type && formRef.current.document === document) setNotice(documentLookupFallback(error));
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (lookup.busy || saveBusy) return;
    if (existing) { onSaved(existing); close(); return; }
    if (form.documentType !== 'SIN_DOCUMENTO') {
      const validation = documentLookupValidation(form.documentType, form.document);
      if (validation) { setError(validation); return; }
    }
    if (!form.name.trim()) { setError('Ingresa el nombre o razón social del cliente.'); return; }
    setSaveBusy(true); setError('');
    try {
      const customer = await post<Customer>('/customers', { ...form, name: form.name.trim(), address: form.address.trim() });
      if (openRef.current) { onSaved(customer); close(); }
    } catch (error) {
      setError(error instanceof ApiError && error.status === 409
        ? error.message + ' Consulta el documento para recuperar el cliente registrado.'
        : error instanceof Error ? error.message : 'No se pudo guardar el cliente.');
    } finally { setSaveBusy(false); }
  }
  const blocked = saveBusy || lookup.busy;
  return <Dialog open={open} onOpenChange={(next) => { if (!next && !saveBusy) close(); }}>
    <DialogContent showCloseButton={!saveBusy}><DialogHeader><DialogTitle>Registrar cliente</DialogTitle><DialogDescription>{documentLookupAvailability(lookup.status, form.documentType === 'SIN_DOCUMENTO' ? undefined : form.documentType)}</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={save}><fieldset disabled={blocked} className="space-y-4">
        <div className="grid grid-cols-[100px_1fr] gap-3"><label className="space-y-2 text-sm font-medium">Documento<select className="h-11 w-full rounded-xl border border-border bg-background px-3" value={form.documentType} onChange={(event) => changeDocument({ ...form, documentType: event.target.value as CustomerInput['documentType'], document: '' })}><option value="DNI">DNI</option><option value="RUC">RUC</option><option value="SIN_DOCUMENTO">Sin doc.</option></select></label><label className="space-y-2 text-sm font-medium">Número<Input className="h-11" value={form.document} disabled={form.documentType === 'SIN_DOCUMENTO'} inputMode="numeric" required={form.documentType !== 'SIN_DOCUMENTO'} pattern={form.documentType === 'RUC' ? '[0-9]{11}' : '[0-9]{8}'} maxLength={form.documentType === 'RUC' ? 11 : 8} placeholder={form.documentType === 'RUC' ? '11 dígitos' : '8 dígitos'} onChange={(event) => changeDocument({ ...form, document: event.target.value.replace(/\D/g, '') })} /></label></div>
        {form.documentType !== 'SIN_DOCUMENTO' ? <Button type="button" variant="outline" className="h-11 w-full" onClick={() => void consult()}><Search className="size-4" />{lookup.busy ? 'Consultando…' : 'Consultar ' + form.documentType}</Button> : null}
        {notice ? <p role="status" className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">{notice}</p> : null}
        <label className="block space-y-2 text-sm font-medium">Nombre o razón social<Input className="h-11" required maxLength={200} value={form.name} disabled={existing !== null} onChange={(event) => updateForm({ ...form, name: event.target.value })} /></label>
        <label className="block space-y-2 text-sm font-medium">Dirección <span className="font-normal text-muted-foreground">(opcional)</span><Input className="h-11" maxLength={500} value={form.address} disabled={existing !== null} onChange={(event) => updateForm({ ...form, address: event.target.value })} /></label>
      </fieldset>{error ? <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-destructive">{error}</p> : null}<div className="flex justify-end gap-2"><Button variant="outline" type="button" className="h-11" disabled={saveBusy} onClick={close}>Cancelar</Button><Button type="submit" className="h-11" disabled={blocked || !form.name.trim()}>{saveBusy ? <LoaderCircle className="size-4 animate-spin" /> : null}{saveBusy ? 'Guardando…' : existing ? 'Usar cliente registrado' : 'Guardar cliente'}</Button></div></form>
    </DialogContent>
  </Dialog>;
}
