import { useRef, useState, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, Banknote, LockKeyhole, Plus } from 'lucide-react';
import type { CashSession, PaymentMethod, User } from '../../shared/types';
import { ApiError, post } from '../lib/api';
import { cents, dateTime, paymentNames, soles } from '../lib/format';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { actionClass, controlClass, EmptyState, ErrorMessage, Feedback, Field, ManagementDialog, messageOf, Metric, useResource } from '../components/management/common';

interface MovementAttempt { idempotencyKey: string; type: 'ingreso' | 'egreso'; amountCents: number; reason: string }
function loadMovementAttempt(storageKey: string): MovementAttempt | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as MovementAttempt;
    return value && typeof value.idempotencyKey === 'string' && ['ingreso', 'egreso'].includes(value.type) && Number.isSafeInteger(value.amountCents) && value.amountCents > 0 && typeof value.reason === 'string' ? value : null;
  } catch { return null; }
}

export default function CashPage({ user }: { user: User }) {
  const cash = useResource<CashSession | null>('/cash', null);
  const history = useResource<CashSession[]>('/cash/history', []);
  const [opening, setOpening] = useState('');
  const [dialog, setDialog] = useState<'movement' | 'close' | null>(null);
  const [movementType, setMovementType] = useState<'ingreso' | 'egreso'>('egreso');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [counted, setCounted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const storageKey = `stockfix-cash-movement-pending-v1:${user.id}`;
  const [pendingMovement, setPendingMovement] = useState<MovementAttempt | null>(() => loadMovementAttempt(storageKey));
  const movementKey = useRef(crypto.randomUUID());
  const session = cash.data;
  const closedSessions = history.data.filter((entry) => entry.closedAt !== null);
  function clearAttempt() {
    setPendingMovement(null); movementKey.current = crypto.randomUUID();
    try { sessionStorage.removeItem(storageKey); } catch { /* The in-memory attempt is still cleared. */ }
  }
  async function saveMovement(input: MovementAttempt) {
    setError(''); setBusy(true);
    try { sessionStorage.setItem(storageKey, JSON.stringify(input)); } catch { /* Keep the exact payload in this tab if storage is unavailable. */ }
    try {
      const result = await post<CashSession>('/cash/movements', input);
      clearAttempt(); cash.setData(result.closedAt ? null : result);
      setDialog(null); setAmount(''); setReason('');
      void cash.refresh(); if (result.closedAt) void history.refresh();
    } catch (error) {
      // Expired authentication does not resolve the outcome of an earlier request.
      const needsRecovery = !(error instanceof ApiError) || error.status >= 500 || error.status === 401 || error.status === 403;
      if (needsRecovery) {
        setPendingMovement(input);
        setError(error instanceof ApiError && (error.status === 401 || error.status === 403)
          ? 'Conservamos el movimiento pendiente. Vuelve a ingresar con la misma cuenta para comprobar su resultado.'
          : 'No se pudo confirmar el movimiento. Conservamos el mismo intento; comprueba su resultado antes de registrar otro movimiento o cerrar caja.');
      } else {
        clearAttempt(); setError(messageOf(error));
      }
      void cash.refresh();
    } finally { setBusy(false); }
  }
  async function open(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!opening.trim() || !Number.isFinite(Number(opening)) || cents(opening) < 0) { setError('Ingresa el efectivo inicial contado. Puede ser cero.'); return; }
    setBusy(true);
    try { cash.setData(await post<CashSession>('/cash/open', { openingCents: cents(opening) })); setOpening(''); }
    catch (error) { setError(messageOf(error)); void cash.refresh(); }
    finally { setBusy(false); }
  }
  async function submitDialog(event: FormEvent) {
    event.preventDefault(); setError('');
    if (dialog === 'movement' && pendingMovement) { await saveMovement(pendingMovement); return; }
    const value = dialog === 'close' ? counted : amount;
    if (!value.trim() || !Number.isFinite(Number(value)) || cents(value) < (dialog === 'close' ? 0 : 1)) { setError('Ingresa un importe válido.'); return; }
    if (dialog === 'movement') {
      if (!reason.trim()) { setError('Escribe el motivo del movimiento.'); return; }
      await saveMovement({ idempotencyKey: movementKey.current, type: movementType, amountCents: cents(amount), reason: reason.trim() });
      return;
    }
    setBusy(true);
    try {
      await post<CashSession>('/cash/close', { countedCents: cents(counted) });
      cash.setData(null); await history.refresh();
      setDialog(null); setAmount(''); setReason(''); setCounted('');
    } catch (error) {
      setDialog(null);
      setError(`${messageOf(error)} Revisa el estado de caja y su historial antes de volver a cerrar.`);
      void cash.refresh(); void history.refresh();
    }
    finally { setBusy(false); }
  }
  function showDialog(kind: 'movement' | 'close') { setError(''); setAmount(''); setReason(''); setCounted(''); setDialog(kind); }
  return <div className="space-y-6"><div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">Caja</h1><p className="mt-1 text-sm text-muted-foreground">Controla el efectivo y compara el cierre con el conteo físico.</p></div>{session ? <div className="flex gap-2"><Button variant="outline" className={actionClass} disabled={busy || pendingMovement !== null} onClick={() => showDialog('movement')}><Plus />Movimiento</Button><Button className={actionClass} disabled={busy || pendingMovement !== null} onClick={() => showDialog('close')}><LockKeyhole />Cerrar caja</Button></div> : null}</div>
    <Feedback loading={cash.loading} error={cash.error} retry={() => void cash.refresh()} />
    {!dialog || !session ? <ErrorMessage message={error} /> : null}
    {pendingMovement ? <Card className="border-primary/30 bg-primary/5 shadow-none"><CardContent className="space-y-3 p-5"><h2 className="font-semibold">Comprobar movimiento pendiente</h2><p className="text-sm text-muted-foreground">El registro pudo completarse aunque la respuesta no llegó. Reintentar este mismo intento recupera el resultado sin duplicar el ingreso o egreso.</p><p className="text-sm"><strong>{pendingMovement.type === 'ingreso' ? 'Ingreso' : 'Egreso'} · {soles(pendingMovement.amountCents)}</strong> · {pendingMovement.reason}</p><Button className={actionClass} disabled={busy} onClick={() => void saveMovement(pendingMovement)}>{busy ? 'Comprobando…' : 'Comprobar resultado'}</Button></CardContent></Card> : null}
    {!cash.loading && !cash.error ? session ? <><Card className="shadow-none"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5"><div className="flex items-center gap-3"><div className="rounded-xl bg-primary/10 p-3"><Banknote className="size-5 text-primary" /></div><div><p className="font-semibold">Caja abierta</p><p className="mt-1 text-xs text-muted-foreground">{dateTime(session.openedAt)} · {session.openedBy}</p></div></div><Badge className="bg-primary/10 text-primary">En operación</Badge></CardContent></Card><div className="grid gap-4 sm:grid-cols-3"><Metric label="Efectivo inicial" value={soles(session.openingCents)} /><Metric label="Cobros en efectivo" value={soles(session.payments.efectivo)} detail="Ventas de esta apertura" /><Metric label="Efectivo esperado" value={soles(session.expectedCents)} detail="Inicial + ventas + ingresos − egresos" /></div><div className="grid gap-5 lg:grid-cols-[1fr_1.7fr]"><Card className="shadow-none"><CardContent className="space-y-4 p-5"><h2 className="font-semibold">Cobros digitales</h2><p className="text-xs leading-relaxed text-muted-foreground">Se registran por separado y no forman parte del dinero físico del cajón.</p>{(['yape', 'plin', 'transferencia'] as PaymentMethod[]).map((method) => <div key={method} className="flex justify-between border-b border-border pb-3 text-sm last:border-0"><span>{paymentNames[method]}</span><strong className="tabular-nums">{soles(session.payments[method])}</strong></div>)}</CardContent></Card><Card className="shadow-none"><CardContent className="p-5"><h2 className="font-semibold">Ingresos y egresos adicionales</h2>{session.movements.length ? <div className="mt-4 divide-y divide-border">{session.movements.map((movement) => <div key={movement.id} className="flex items-start gap-3 py-3"><div className={`rounded-lg p-2 ${movement.type === 'ingreso' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{movement.type === 'ingreso' ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}</div><div className="min-w-0 flex-1"><p className="text-sm font-medium">{movement.reason}</p><p className="mt-1 text-xs text-muted-foreground">{dateTime(movement.createdAt)} · {movement.userName}</p></div><strong className="whitespace-nowrap text-sm tabular-nums">{movement.type === 'egreso' ? '−' : '+'}{soles(movement.amountCents)}</strong></div>)}</div> : <p className="py-8 text-sm text-muted-foreground">Aún no hay movimientos adicionales en esta caja.</p>}</CardContent></Card></div></> : <Card className="max-w-lg shadow-none"><CardContent className="space-y-5 p-6"><div className="w-fit rounded-2xl bg-primary/10 p-4"><Banknote className="size-7 text-primary" /></div><div><h2 className="text-lg font-semibold">Abre la caja para comenzar</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Cuenta el dinero disponible antes de la primera venta. {user.name}, quedará registrado que tú realizaste la apertura.</p></div><form onSubmit={open} className="space-y-4"><Field label="Efectivo inicial (S/)"><Input className={controlClass} type="number" min="0" step="0.01" placeholder="0.00" required value={opening} onChange={(e) => setOpening(e.target.value)} disabled={busy || pendingMovement !== null} /></Field><Button type="submit" className={`${actionClass} w-full`} disabled={busy || pendingMovement !== null}>{busy ? 'Abriendo…' : 'Abrir caja'}</Button></form></CardContent></Card> : null}
    <Card className="gap-0 overflow-hidden py-0 shadow-none"><CardContent className="p-0"><h2 className="border-b border-border p-5 font-semibold">Historial de cierres</h2><Feedback loading={history.loading} error={history.error} retry={() => void history.refresh()} />{!history.loading && !history.error ? closedSessions.length ? <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-5 py-3">Apertura / responsable</th><th className="px-5 py-3">Cierre</th><th className="px-5 py-3">Esperado</th><th className="px-5 py-3">Contado</th><th className="px-5 py-3">Diferencia</th></tr></thead><tbody>{closedSessions.map((closed) => <tr key={closed.id} className="border-t border-border"><td className="px-5 py-4"><p>{dateTime(closed.openedAt)}</p><p className="mt-1 text-xs text-muted-foreground">{closed.openedBy}</p></td><td className="px-5 py-4 text-muted-foreground">{closed.closedAt ? dateTime(closed.closedAt) : 'Abierta'}</td><td className="px-5 py-4 tabular-nums">{soles(closed.expectedCents)}</td><td className="px-5 py-4 tabular-nums">{closed.countedCents === null ? '—' : soles(closed.countedCents)}</td><td className={`px-5 py-4 font-medium tabular-nums ${closed.differenceCents !== null && closed.differenceCents !== 0 ? 'text-destructive' : 'text-primary'}`}>{closed.differenceCents === null ? '—' : soles(closed.differenceCents)}</td></tr>)}</tbody></table></div> : <EmptyState title="Aún no hay cierres" detail="Al cerrar una caja conservarás el efectivo esperado, el contado y la diferencia." /> : null}</CardContent></Card>
    {dialog && session ? <ManagementDialog open onClose={() => { setDialog(null); setError(''); }} title={dialog === 'close' ? 'Cerrar y contar caja' : 'Registrar movimiento'} detail={dialog === 'close' ? 'Cuenta solamente el efectivo físico. Los cobros digitales se muestran por separado.' : 'Registra dinero que entra o sale del cajón fuera de las ventas.'} busy={busy}><form onSubmit={submitDialog} className="space-y-5"><ErrorMessage message={error} /><fieldset disabled={busy || pendingMovement !== null} className="space-y-4">{dialog === 'close' ? <><div className="rounded-xl bg-muted p-4"><p className="text-sm text-muted-foreground">Efectivo esperado</p><p className="mt-1 text-2xl font-semibold">{soles(session.expectedCents)}</p></div><Field label="Efectivo contado (S/)"><Input className={controlClass} type="number" min="0" step="0.01" required value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus /></Field>{counted !== '' && Number.isFinite(Number(counted)) ? <p className="text-sm">Diferencia: <strong className={cents(counted) === session.expectedCents ? 'text-primary' : 'text-destructive'}>{soles(cents(counted) - session.expectedCents)}</strong></p> : null}<p className="text-xs leading-relaxed text-muted-foreground">Después del cierre deberás abrir una nueva caja para seguir registrando ventas.</p></> : <><Field label="Tipo de movimiento"><select className={controlClass} value={movementType} onChange={(e) => setMovementType(e.target.value as 'ingreso' | 'egreso')}><option value="egreso">Egreso · sacar dinero</option><option value="ingreso">Ingreso · agregar dinero</option></select></Field><Field label="Importe (S/)"><Input className={controlClass} type="number" min="0.01" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field><Field label="Motivo"><Input className={controlClass} required maxLength={200} placeholder="Ejemplo: pago de transporte" value={reason} onChange={(e) => setReason(e.target.value)} /></Field></>}</fieldset><div className="flex justify-end gap-2"><Button type="button" variant="outline" className={actionClass} disabled={busy} onClick={() => { setDialog(null); setError(''); }}>Cancelar</Button><Button type="submit" className={actionClass} disabled={busy}>{busy ? 'Guardando…' : dialog === 'close' ? 'Confirmar cierre' : pendingMovement ? 'Comprobar resultado' : 'Guardar movimiento'}</Button></div></form></ManagementDialog> : null}
  </div>;
}
