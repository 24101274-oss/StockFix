import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, LoaderCircle, PackageOpen, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';

export const controlClass = 'min-h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-50';
export const actionClass = 'min-h-11 px-4';
export const messageOf = (error: unknown) => error instanceof Error ? error.message : 'No se pudo completar la operación.';

export function useResource<T>(path: string, initial: T, enabled = true) {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!enabled) { setLoading(false); return; }
    setLoading(true); setError('');
    try { setData(await api<T>(path)); }
    catch (error) { setError(messageOf(error)); }
    finally { setLoading(false); }
  }, [path, enabled]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { data, setData, loading, error, refresh };
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-2 text-sm font-medium text-foreground"><span>{label}</span>{children}{hint ? <span className="text-xs font-normal leading-relaxed text-muted-foreground">{hint}</span> : null}</label>;
}

export function ErrorMessage({ message }: { message: string }) {
  return message ? <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>{message}</span></div> : null;
}

export function Feedback({ loading, error, retry }: { loading: boolean; error: string; retry: () => void }) {
  if (error) return <div className="space-y-3"><ErrorMessage message={error} /><Button variant="outline" className={actionClass} onClick={retry}><RefreshCw />Volver a intentar</Button></div>;
  return loading ? <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Cargando información…</div> : null;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="grid justify-items-center gap-2 px-6 py-12 text-center"><div className="mb-2 rounded-2xl bg-muted p-4"><PackageOpen className="size-7 text-muted-foreground" /></div><p className="font-semibold">{title}</p><p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{detail}</p></div>;
}

export function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return <Card className="shadow-none"><CardContent className="space-y-2 p-5"><p className="text-sm text-muted-foreground">{label}</p><p className="text-2xl font-semibold tracking-tight">{value}</p>{detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}</CardContent></Card>;
}

export function ManagementDialog({ open, onClose, title, detail, children, wide = false, busy = false }: { open: boolean; onClose: () => void; title: string; detail: string; children: ReactNode; wide?: boolean; busy?: boolean }) {
  return <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}><DialogContent className={`max-h-[90dvh] overflow-y-auto ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`} showCloseButton={!busy}><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{detail}</DialogDescription></DialogHeader>{children}</DialogContent></Dialog>;
}
