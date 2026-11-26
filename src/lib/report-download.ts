import { ApiError } from './api';

export type ReportFormat = 'xlsx' | 'csv';

const maxReportBytes = 25 * 1024 * 1024;
const reportMime: Record<ReportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

async function readBounded(response: Response, limit: number): Promise<Blob> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (contentLength > limit) throw new Error('El reporte es demasiado grande. Reduce el rango de fechas y vuelve a intentar.');
  if (!response.body) throw new Error('El servidor no devolvió un archivo. Vuelve a intentar.');
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('El reporte es demasiado grande. Reduce el rango de fechas y vuelve a intentar.');
      }
      chunks.push(value.slice().buffer as ArrayBuffer);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error('El archivo está vacío. Vuelve a intentar.');
  return new Blob(chunks, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
}

function reportFilename(header: string | null, endpoint: string, format: ReportFormat): string {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const ordinary = header?.match(/filename="([^"]+)"|filename=([^;]+)/i);
  let name = ordinary?.[1] || ordinary?.[2]?.trim() || '';
  if (encoded) {
    try { name = decodeURIComponent(encoded); } catch { /* Use the ordinary filename if its encoded counterpart is invalid. */ }
  }
  name = name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().slice(0, 180) || '';
  if (!name) name = `stockfix-${endpoint.split('/')[2]}-${new Date().toISOString().slice(0, 10)}`;
  return name.toLowerCase().endsWith(`.${format}`) ? name : `${name.replace(/\.(xlsx|csv)$/i, '')}.${format}`;
}

export async function downloadReport(endpoint: string, params: Record<string, string> | undefined, format: ReportFormat, signal?: AbortSignal): Promise<void> {
  if (endpoint !== '/forecast/export' && !/^\/reports\/[a-z-]+\/export$/.test(endpoint)) throw new Error('No se reconoce este reporte.');
  const query = new URLSearchParams(params);
  query.set('format', format);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(abort, 45_000);
  try {
    const response = await fetch(`/api${endpoint}?${query}`, {
      credentials: 'same-origin',
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: reportMime[format] },
    });
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('auth-expired'));
      let message = response.status === 401 ? 'Tu sesión venció. Inicia sesión para descargar el reporte.' : response.status === 403 ? 'Solo el administrador puede exportar reportes.' : 'No se pudo generar el reporte. Vuelve a intentar.';
      if (response.status !== 401 && response.status !== 403 && response.headers.get('Content-Type')?.includes('application/json')) {
        try {
          const payload = JSON.parse(await (await readBounded(response, 16 * 1024)).text()) as { message?: unknown; error?: unknown };
          const detail = payload.message ?? payload.error;
          if (typeof detail === 'string' && detail.length < 500) message = detail;
        } catch { /* Keep a useful message if the error response is invalid. */ }
      }
      throw new ApiError(message, response.status);
    }
    if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== reportMime[format]) {
      throw new Error('El servidor devolvió una respuesta que no es un reporte. Vuelve a intentar.');
    }
    const blob = await readBounded(response, maxReportBytes);
    if (format === 'xlsx') {
      const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) {
        throw new Error('El archivo Excel no es válido. Vuelve a intentar.');
      }
    }
    if (controller.signal.aborted) throw new DOMException('Descarga cancelada.', 'AbortError');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = reportFilename(response.headers.get('Content-Disposition'), endpoint, format);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('La descarga tardó demasiado. Reduce el rango de fechas o vuelve a intentar.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    // Cancel any unread body when headers or validation reject the response.
    controller.abort();
  }
}
