import type { DocumentLookupResult, DocumentLookupStatus } from '../shared/types';
import { isValidRuc } from './validation';

type LookupType = DocumentLookupResult['documentType'];
type ExternalResult = Omit<DocumentLookupResult, 'customer'>;
export type LookupFetch = (url: string, options: RequestInit) => Promise<Response>;
export interface DocumentLookupOptions {
  token?: string; dniEnabled?: boolean; rucEnabled?: boolean; fetch?: LookupFetch;
  timeoutMs?: number; cacheTtlMs?: number; cacheMaxEntries?: number;
  rateLimit?: number; rateWindowMs?: number; now?: () => number;
}
export class DocumentLookupError extends Error {
  constructor(message: string, readonly statusCode: number, readonly retryAfterSeconds?: number) {
    super(message); this.name = 'DocumentLookupError';
  }
}
const PROVIDER_URL = 'https://api.apiperu.pe';
const MAX_RESPONSE_BYTES = 64 * 1024;
const FALLBACK = 'Completa los datos manualmente.';
function unavailable(message = 'El proveedor de consultas no está disponible.') {
  return new DocumentLookupError(`${message} ${FALLBACK}`, 503);
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  const result = value.trim().replace(/\s+/g, ' ');
  if (result.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(result)) throw unavailable('La respuesta del proveedor no pudo validarse.');
  return result;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function normalize(payload: unknown, documentType: LookupType, document: string, fetchedAt: string): ExternalResult {
  const envelope = record(payload);
  const data = record(envelope?.data);
  if (envelope?.success !== true || !data) throw unavailable('La respuesta del proveedor no pudo validarse.');
  const returnedDocument = documentType === 'DNI' ? data.numero : data.ruc;
  if (typeof returnedDocument !== 'string' || returnedDocument.trim() !== document) throw unavailable('El proveedor devolvió un documento diferente o incompleto.');
  let name = documentType === 'RUC' ? text(data.nombre_o_razon_social, 200) : text(data.nombre_completo, 200);
  if (!name && documentType === 'DNI') {
    const names = text(data.nombres, 100), paternal = text(data.apellido_paterno, 100), maternal = text(data.apellido_materno, 100);
    if (names && paternal) name = [names, paternal, maternal].filter(Boolean).join(' ');
  }
  if (!name || name.length > 200) throw unavailable('El proveedor no devolvió un nombre válido.');
  const address = text(data.direccion_completa, 500) || text(data.direccion, 500);
  return { documentType, document, name, address, source: 'api_peru', cached: false, fetchedAt };
}
async function readJson(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) throw unavailable('El proveedor devolvió una respuesta inesperada.');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) { await response.body.cancel(); throw unavailable('La respuesta del proveedor supera el tamaño permitido.'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_RESPONSE_BYTES) throw unavailable('La respuesta del proveedor supera el tamaño permitido.');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw unavailable('El proveedor devolvió datos que no pudieron validarse.'); }
}

export function createDocumentLookup(options: DocumentLookupOptions = {}) {
  // The token is read only on the server. The endpoint is fixed; an environment
  // variable or a customer-supplied URL cannot redirect credentials elsewhere.
  const token = (options.token ?? process.env.APIPERU_TOKEN ?? '').trim();
  const dniEnabled = options.dniEnabled ?? process.env.APIPERU_DNI_ENABLED !== 'false';
  const rucEnabled = options.rucEnabled ?? process.env.APIPERU_RUC_ENABLED !== 'false';
  const configured = token.length > 0;
  const fetchProvider = options.fetch ?? fetch;
  const clock = options.now ?? Date.now;
  const timeoutMs = Math.min(10_000, Math.max(10, options.timeoutMs ?? 5_000));
  const cacheTtlMs = Math.min(3_600_000, Math.max(1, options.cacheTtlMs ?? 900_000));
  const cacheMaxEntries = Math.min(500, Math.max(1, options.cacheMaxEntries ?? 200));
  const rateLimit = Math.min(60, Math.max(1, options.rateLimit ?? 20));
  const rateWindowMs = Math.min(3_600_000, Math.max(1, options.rateWindowMs ?? 60_000));
  const cache = new Map<string, { expiresAt: number; result: ExternalResult }>();
  const pending = new Map<string, Promise<ExternalResult>>();
  const users = new Map<string, { count: number; expiresAt: number }>();
  function consumeRateLimit(userId: string) {
    const current = clock();
    for (const [key, value] of users) if (value.expiresAt <= current) users.delete(key);
    const entry = users.get(userId) ?? { count: 0, expiresAt: current + rateWindowMs };
    if (entry.count >= rateLimit) throw new DocumentLookupError(`Alcanzaste el límite temporal de consultas. Espera un momento o completa los datos manualmente.`, 429, Math.max(1, Math.ceil((entry.expiresAt - current) / 1000)));
    if (!users.has(userId) && users.size >= 1000) throw unavailable('El servicio de consultas está ocupado.');
    entry.count++;
    users.set(userId, entry);
  }
  async function requestProvider(documentType: LookupType, document: string): Promise<ExternalResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable('La consulta tardó demasiado.')); }, timeoutMs);
    });
    const operation = (async () => {
      const response = await fetchProvider(`${PROVIDER_URL}/${documentType.toLowerCase()}`, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [documentType.toLowerCase()]: document }), redirect: 'error', signal: controller.signal,
      });
      if (response.status === 404) throw new DocumentLookupError(`No se pudieron obtener datos para este documento. Revisa el número o completa el registro manualmente.`, 404);
      if (response.status === 429) throw unavailable('El proveedor alcanzó su límite de consultas.');
      if (response.status === 401 || response.status === 403) throw unavailable('Las credenciales del proveedor deben ser revisadas por la administración.');
      if (response.status !== 200) throw unavailable();
      return normalize(await readJson(response), documentType, document, new Date(clock()).toISOString());
    })();
    try { return await Promise.race([operation, timeout]); }
    catch (error) { if (error instanceof DocumentLookupError) throw error; throw unavailable(); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  return {
    status(): DocumentLookupStatus { return { provider: 'api_peru', configured, dniEnabled: configured && dniEnabled, rucEnabled: configured && rucEnabled }; },
    async lookup(documentType: LookupType, document: string, userId: string): Promise<ExternalResult> {
      if (documentType === 'DNI' ? !/^\d{8}$/.test(document) : !isValidRuc(document)) throw new DocumentLookupError('El documento no tiene un formato válido.', 400);
      if (!configured || !(documentType === 'DNI' ? dniEnabled : rucEnabled)) throw new DocumentLookupError(`La consulta externa ${documentType} todavía no está habilitada. ${FALLBACK}`, 404);
      consumeRateLimit(userId);
      const key = `${documentType}:${document}`;
      const current = clock();
      for (const [storedKey, entry] of cache) if (entry.expiresAt <= current) cache.delete(storedKey);
      const stored = cache.get(key);
      if (stored) return { ...stored.result, cached: true };
      const existing = pending.get(key);
      if (existing) return { ...await existing, cached: true };
      if (pending.size >= 50) throw unavailable('El servicio de consultas está ocupado.');
      const operation = requestProvider(documentType, document).then(result => {
        if (cache.size >= cacheMaxEntries) cache.delete(cache.keys().next().value!);
        cache.set(key, { expiresAt: clock() + cacheTtlMs, result });
        return result;
      });
      pending.set(key, operation);
      try { return { ...await operation }; }
      finally { pending.delete(key); }
    },
  };
}
