import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentLookupResult, DocumentLookupStatus } from '../../shared/types';
import { api } from './api';

export type LookupDocumentType = 'DNI' | 'RUC';
export function documentLookupValidation(type: LookupDocumentType, document: string) {
  const length = type === 'DNI' ? 8 : 11;
  return new RegExp(`^\\d{${length}}$`).test(document) ? '' : `Ingresa un ${type} de ${length} dígitos para consultar.`;
}
export function documentLookupNotice(result: DocumentLookupResult) {
  const source = result.source === 'registro_local' ? 'Datos guardados' : result.cached ? 'Consulta API Perú · datos en caché' : 'Consulta API Perú';
  return `${source}. Revisa el nombre o razón social y la dirección antes de guardar.`;
}
export function documentLookupAvailability(status: DocumentLookupStatus | null, type?: LookupDocumentType) {
  if (!status) return 'Consulta datos guardados y, si está configurada, API Perú. Puedes completar los datos manualmente.';
  if (!status.configured) return 'API Perú no está configurada. Puedes recuperar datos guardados o completar los datos manualmente.';
  if (type && !(type === 'DNI' ? status.dniEnabled : status.rucEnabled)) return `La consulta externa de ${type} no está habilitada. Puedes recuperar datos guardados o registrarlos manualmente.`;
  return 'Consulta primero los datos guardados y, cuando corresponda, API Perú. Verifica el resultado antes de guardar.';
}
export function documentLookupFallback(error: unknown) {
  const message = error instanceof Error ? error.message : 'No se pudo completar la consulta.';
  return /manual/i.test(message) ? message : `${message} Puedes completar los datos manualmente.`;
}
/** A cancelled or superseded lookup never returns data to a form. */
export function useDocumentLookup() {
  const [status, setStatus] = useState<DocumentLookupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const statusController = new AbortController();
    api<DocumentLookupStatus>('/lookup/status', { signal: statusController.signal }).then((result) => {
      if (!statusController.signal.aborted) setStatus(result);
    }).catch(() => { /* Manual registration remains usable when status cannot be obtained. */ });
    return () => { mounted.current = false; requestId.current += 1; controller.current?.abort(); statusController.abort(); };
  }, []);
  const cancel = useCallback(() => {
    requestId.current += 1; controller.current?.abort(); controller.current = null;
    if (mounted.current) setBusy(false);
  }, []);
  const query = useCallback(async (type: LookupDocumentType, document: string): Promise<DocumentLookupResult | null> => {
    const validation = documentLookupValidation(type, document);
    if (validation) throw new Error(validation);
    controller.current?.abort();
    const id = ++requestId.current;
    const requestController = new AbortController();
    controller.current = requestController; setBusy(true);
    try {
      const result = await api<DocumentLookupResult>(`/lookup/${type.toLowerCase()}/${encodeURIComponent(document)}`, { signal: requestController.signal });
      return mounted.current && requestId.current === id && !requestController.signal.aborted ? result : null;
    } catch (error) {
      if (!mounted.current || requestId.current !== id || requestController.signal.aborted) return null;
      throw error;
    } finally { if (mounted.current && requestId.current === id) { setBusy(false); controller.current = null; } }
  }, []);
  return { status, busy, query, cancel };
}
