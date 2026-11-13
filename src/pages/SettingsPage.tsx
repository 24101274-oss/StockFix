import { useEffect, useState } from 'react';
import { CircleCheck, ExternalLink, LockKeyhole, Printer, ShieldCheck } from 'lucide-react';
import type { DocumentLookupStatus, Settings } from '../../shared/types';
import { api } from '../lib/api';
import { ErrorNotice, Loading, PageHeader } from '../components/State';
export default function SettingsPage() {
  const [data, setData] = useState<Settings | null>(null);
  const [lookup, setLookup] = useState<DocumentLookupStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stopped = false;
    Promise.all([api<Settings>('/settings'), api<DocumentLookupStatus>('/lookup/status')])
      .then(([settings, status]) => {
        if (!stopped) { setData(settings); setLookup(status); }
      })
      .catch(e => { if (!stopped) setError(e.message); });
    return () => { stopped = true; };
  }, []);

  if (error) return <ErrorNotice message={error} />;
  if (!data || !lookup) return <Loading />;

  return (
    <div className="page-stack">
      <PageHeader title="Configuración" description="Datos del negocio y estado de las integraciones." />
      <div className="settings-grid">
        <section className="panel">
          <div className="section-heading"><h2>Datos de la empresa</h2><ShieldCheck size={20} /></div>
          <dl className="detail-list">
            <div><dt>Nombre del sistema</dt><dd>{data.businessName}</dd></div>
            <div><dt>RUC de la empresa</dt><dd>{data.ruc}</dd></div>
            <div><dt>Dirección fiscal</dt><dd>{data.address || 'Pendiente de confirmar'}</dd></div>
            <div><dt>Configuración tributaria</dt><dd><span className="badge-warning">Pendiente de confirmar</span></dd></div>
            <div><dt>Precios de venta</dt><dd>Importes finales, sin recargos al cobrar</dd></div>
          </dl>
        </section>

        <section className="panel">
          <div className="section-heading"><h2>Facturación electrónica</h2><LockKeyhole size={20} /></div>
          <div className="fiscal-note">
            <strong>NubeFact todavía no está conectado</strong>
            <p>La emisión real se habilitará después de contratar la API y confirmar la configuración tributaria.</p>
          </div>
          <div className="status-row"><CircleCheck size={18} /><span>Documentos de prueba identificados</span></div>
          <div className="status-row"><CircleCheck size={18} /><span>Sin envío automático a SUNAT</span></div>
          <p className="muted-note">La razón social, las series fiscales y el desglose del IGV se configurarán antes de emitir comprobantes reales.</p>
        </section>

        <section className="panel">
          <div className="section-heading"><h2>Impresión de documentos</h2><Printer size={20} /></div>
          <p>Vista imprimible de 80 mm para revisar el contenido del ticket.</p>
          <div className="muted-note">
            <strong>Prueba pendiente en la iMin Swan 2</strong>
            <p>La impresión directa mediante el SDK de iMin se verificará con el equipo físico. La vista del navegador todavía no confirma compatibilidad con su impresora integrada.</p>
          </div>
        </section>

        <section className="panel">
          <div className="section-heading"><h2>Consultas de DNI y RUC</h2><ShieldCheck size={20} /></div>
          <p>Se buscan primero los datos guardados. Para documentos nuevos, API Perú permite completar nombres y razón social.</p>
          <dl className="detail-list">
            <div><dt>Proveedor</dt><dd>API Perú</dd></div>
            <div><dt>Configuración</dt><dd><span className={lookup.configured ? 'badge-success' : 'badge-warning'}>{lookup.configured ? 'Token configurado' : 'Falta configurar el token'}</span></dd></div>
            <div><dt>Consulta DNI</dt><dd>{lookup.dniEnabled ? 'Habilitada' : 'Datos guardados y registro manual'}</dd></div>
            <div><dt>Consulta RUC</dt><dd>{lookup.rucEnabled ? 'Habilitada' : 'Datos guardados y registro manual'}</dd></div>
          </dl>
          <p className="muted-note">Revisa los datos antes de guardarlos. Si la consulta no responde o se agota el cupo, puedes completar el registro manualmente. Estas consultas son independientes de NubeFact.</p>
          {!lookup.configured && (
            <div className="muted-note">
              <p>Para activar las consultas externas, crea tu cuenta y configura su token de forma privada en el servidor.</p>
              <a className="inline-flex items-center gap-2 font-medium text-primary" href="https://apiperu.pe/registro/" target="_blank" rel="noopener noreferrer">Crear cuenta en API Perú <ExternalLink size={16} /></a>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
