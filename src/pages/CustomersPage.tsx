import { useEffect, useMemo, useState } from 'react';
import { Plus, Search, Users } from 'lucide-react';
import type { Customer } from '../../shared/types';
import { api } from '../lib/api';
import CustomerDialog from '../components/pos/CustomerDialog';
import { Empty, ErrorNotice, Loading, PageHeader } from '../components/State';

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api<Customer[]>('/customers').then((data) => { if (!cancelled) setCustomers(data); }).catch((error) => { if (!cancelled) setError(error.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  const filtered = useMemo(() => customers.filter((customer) => (customer.name + ' ' + customer.document).toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es'))), [customers, query]);
  return <div className="page-stack"><PageHeader title="Clientes" description="Guarda sus datos para reutilizarlos en próximas ventas."><button className="btn-primary" onClick={() => setOpen(true)}><Plus size={18} />Nuevo cliente</button></PageHeader><section className="panel"><div className="toolbar"><div className="search-field"><Search size={18} /><input aria-label="Buscar cliente" placeholder="Buscar por nombre, DNI o RUC…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><span className="badge-neutral">{customers.length} clientes</span></div>{error ? <ErrorNotice message={error} /> : loading ? <Loading /> : filtered.length ? <div className="table-scroll"><table><thead><tr><th>Cliente</th><th>Documento</th><th>Dirección</th></tr></thead><tbody>{filtered.map((customer) => <tr key={customer.id}><td><div className="cell-person"><span><Users size={17} /></span><strong>{customer.name}</strong></div></td><td>{customer.documentType === 'SIN_DOCUMENTO' ? 'Sin documento' : customer.documentType + ' ' + customer.document}</td><td>{customer.address || '—'}</td></tr>)}</tbody></table></div> : <Empty title="No hay clientes para mostrar">Puedes registrar uno al realizar una venta.</Empty>}</section><CustomerDialog open={open} onOpenChange={setOpen} selectExistingAutomatically={false} onSaved={(customer) => { setCustomers((current) => [customer, ...current.filter((item) => item.id !== customer.id)]); setOpen(false); }} /></div>;
}
