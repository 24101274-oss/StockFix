import { useEffect, useRef, useState } from 'react';
import { Download, FileSpreadsheet, LoaderCircle, RefreshCw } from 'lucide-react';
import { downloadReport, type ReportFormat } from '../lib/report-download';
import { Button } from './ui/button';

interface ReportExportProps {
  endpoint: string;
  params?: Record<string, string>;
  disabled?: boolean;
  body?: unknown;
}

export default function ReportExport({ endpoint, params, disabled = false, body }: ReportExportProps) {
  const [busy, setBusy] = useState<ReportFormat | null>(null);
  const [lastFormat, setLastFormat] = useState<ReportFormat>('xlsx');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);

  async function run(format: ReportFormat) {
    if (activeRequest.current || disabled) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(format); setLastFormat(format); setError(''); setMessage('');
    try {
      await downloadReport(endpoint, params, format, controller.signal, body);
      if (!controller.signal.aborted) setMessage(`Reporte ${format === 'xlsx' ? 'Excel' : 'CSV'} enviado a las descargas de tu dispositivo.`);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'No se pudo descargar el reporte. Vuelve a intentar.');
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2" role="group" aria-label="Exportar reporte">
      <Button type="button" variant="outline" className="h-11" disabled={disabled || busy !== null} onClick={() => void run('xlsx')}>
        {busy === 'xlsx' ? <LoaderCircle className="size-4 animate-spin" /> : <FileSpreadsheet className="size-4" />}
        {busy === 'xlsx' ? 'Generando Excel…' : 'Exportar Excel'}
      </Button>
      <Button type="button" variant="outline" className="h-11" disabled={disabled || busy !== null} onClick={() => void run('csv')}>
        {busy === 'csv' ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
        {busy === 'csv' ? 'Generando CSV…' : 'Exportar CSV'}
      </Button>
    </div>
    {error ? <div className="flex flex-wrap items-center gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert"><span>{error}</span><Button type="button" variant="link" className="h-11 text-destructive" disabled={disabled || busy !== null} onClick={() => void run(lastFormat)}><RefreshCw className="size-4" /> Reintentar</Button></div> : null}
    <p aria-live="polite" className="text-xs text-muted-foreground">{busy ? 'Preparando el archivo con todos los registros que coinciden con tus filtros…' : message}</p>
  </div>;
}
