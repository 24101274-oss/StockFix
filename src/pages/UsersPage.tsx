import { useMemo, useState, type FormEvent } from 'react';
import { KeyRound, Pencil, Plus, Search, ShieldCheck, UserRoundCheck, UserRoundX } from 'lucide-react';
import type { User } from '../../shared/types';
import type { CreateUserInput, ManagedUser, UpdateUserInput, UserManagementResult } from '../../shared/users';
import { patch, post } from '../lib/api';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { actionClass, controlClass, EmptyState, ErrorMessage, Feedback, Field, ManagementDialog, messageOf, Metric, useResource } from '../components/management/common';

const roleNames = { admin: 'Administrador', cashier: 'Cajero' };
function UserEditor({ account, currentUser, onClose, onSaved }: { account: ManagedUser | null; currentUser: User; onClose: () => void; onSaved: (result: UserManagementResult) => void }) {
  const [name, setName] = useState(account?.name ?? '');
  const [email, setEmail] = useState(account?.email ?? '');
  const [role, setRole] = useState<User['role']>(account?.role ?? 'cashier');
  const [active, setActive] = useState(account?.active ?? true);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const self = account?.id === currentUser.id;
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!name.trim()) { setError('Ingresa el nombre del usuario.'); return; }
    if (!account && password !== confirmation) { setError('Las contraseñas no coinciden.'); return; }
    setBusy(true);
    const input: UpdateUserInput = { name: name.trim(), email: email.trim().toLowerCase(), role, active };
    try {
      if (account) onSaved(await patch<UserManagementResult>(`/users/${account.id}`, input));
      else {
        const create: CreateUserInput = { ...input, password };
        onSaved({ user: await post<ManagedUser>('/users', create), sessionsRevoked: false, selfSessionRevoked: false });
      }
    } catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <ManagementDialog open onClose={onClose} title={account ? 'Editar usuario' : 'Nuevo usuario'} detail="Cada persona ingresa con su propia cuenta y los permisos de su rol." busy={busy}><form onSubmit={save} className="space-y-5"><ErrorMessage message={error} /><fieldset disabled={busy} className="space-y-4"><Field label="Nombre"><Input className={controlClass} required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Correo de acceso"><Input className={controlClass} type="email" autoComplete="off" required maxLength={200} value={email} onChange={(event) => setEmail(event.target.value)} /></Field><Field label="Rol" hint={self ? 'Tu cuenta debe conservar el rol de administrador.' : 'Administrador: gestión y reportes. Cajero: ventas, clientes, inventario de consulta y caja.'}><select className={controlClass} value={role} disabled={self} onChange={(event) => setRole(event.target.value as User['role'])}><option value="cashier">Cajero</option><option value="admin">Administrador</option></select></Field><label className="flex min-h-11 items-center gap-3 text-sm" style={{ flexDirection: 'row' }}><input type="checkbox" className="size-5" checked={active} disabled={self} onChange={(event) => setActive(event.target.checked)} />Cuenta activa</label>{!account ? <><Field label="Contraseña" hint="Al menos 12 caracteres. La persona deberá usarla para ingresar."><Input className={controlClass} type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={password} onChange={(event) => setPassword(event.target.value)} /></Field><Field label="Repetir contraseña"><Input className={controlClass} type="password" autoComplete="new-password" minLength={12} maxLength={200} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field></> : <p className="rounded-xl bg-muted p-3 text-xs leading-relaxed text-muted-foreground">Cambiar el correo, el rol o desactivar la cuenta cerrará sus sesiones. Cambiar solo el nombre mantiene el acceso actual.</p>}</fieldset><div className="flex justify-end gap-2"><Button type="button" variant="outline" className={actionClass} disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" className={actionClass} disabled={busy}>{busy ? 'Guardando…' : 'Guardar usuario'}</Button></div></form></ManagementDialog>;
}

function PasswordEditor({ account, onClose, onSaved }: { account: ManagedUser; onClose: () => void; onSaved: (result: UserManagementResult) => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    if (password !== confirmation) { setError('Las contraseñas no coinciden.'); return; }
    setBusy(true);
    try { onSaved(await post<UserManagementResult>(`/users/${account.id}/password`, { password })); }
    catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <ManagementDialog open onClose={onClose} title="Cambiar contraseña" detail={`${account.name} · ${account.email}`} busy={busy}><form onSubmit={save} className="space-y-5"><ErrorMessage message={error} /><fieldset disabled={busy} className="space-y-4"><p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">La nueva contraseña cerrará todas las sesiones de esta cuenta. No se muestra ni se recupera su contraseña anterior.</p><Field label="Nueva contraseña" hint="Al menos 12 caracteres."><Input className={controlClass} type="password" required minLength={12} maxLength={200} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field><Field label="Repetir contraseña"><Input className={controlClass} type="password" required minLength={12} maxLength={200} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field></fieldset><div className="flex justify-end gap-2"><Button type="button" variant="outline" className={actionClass} disabled={busy} onClick={onClose}>Cancelar</Button><Button type="submit" className={actionClass} disabled={busy}>{busy ? 'Guardando…' : 'Cambiar contraseña'}</Button></div></form></ManagementDialog>;
}

export default function UsersPage({ user }: { user: User }) {
  const users = useResource<ManagedUser[]>('/users', [], user.role === 'admin');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [editor, setEditor] = useState<ManagedUser | 'new' | null>(null);
  const [passwordEditor, setPasswordEditor] = useState<ManagedUser | null>(null);
  const [activation, setActivation] = useState<ManagedUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const filtered = useMemo(() => users.data.filter((account) => `${account.name} ${account.email}`.toLowerCase().includes(search.trim().toLowerCase()) && (status === 'all' || status === 'active' && account.active || status === 'inactive' && !account.active)), [users.data, search, status]);
  function saved(result: UserManagementResult) {
    users.setData((current) => current.some((account) => account.id === result.user.id) ? current.map((account) => account.id === result.user.id ? result.user : account) : [...current, result.user]);
    setEditor(null); setPasswordEditor(null); setActivation(null); setError('');
    if (result.selfSessionRevoked) {
      window.dispatchEvent(new CustomEvent('auth-expired', { detail: { message: 'Actualizaste tu acceso. Ingresa nuevamente con tu correo y contraseña actuales.', email: result.user.email } }));
      return;
    }
    if (result.user.id === user.id) window.dispatchEvent(new CustomEvent('user-profile-updated', { detail: result.user }));
    setNotice(result.sessionsRevoked ? 'Usuario actualizado. Sus sesiones anteriores se cerraron.' : 'Usuario guardado correctamente.');
  }
  async function toggleActive() {
    if (!activation) return;
    setBusy(true); setError('');
    try { saved(await patch<UserManagementResult>(`/users/${activation.id}`, { name: activation.name, email: activation.email, role: activation.role, active: !activation.active })); }
    catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  if (user.role !== 'admin') return <EmptyState title="Acceso reservado" detail="Solo una cuenta administradora puede gestionar usuarios." />;
  return <div className="space-y-6"><div className="flex flex-wrap justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">Usuarios</h1><p className="mt-1 text-sm text-muted-foreground">Administra quién puede ingresar y qué funciones puede utilizar.</p></div><Button className={actionClass} onClick={() => { setNotice(''); setEditor('new'); }}><Plus />Nuevo usuario</Button></div><div className="grid gap-4 sm:grid-cols-3"><Metric label="Cuentas registradas" value={users.data.length} /><Metric label="Usuarios activos" value={users.data.filter((account) => account.active).length} /><Metric label="Administradores activos" value={users.data.filter((account) => account.active && account.role === 'admin').length} /></div><Card className="shadow-none"><CardContent className="flex items-start gap-3 p-4"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" /><p className="text-sm leading-relaxed text-muted-foreground">Desactivar una cuenta conserva sus operaciones y le impide ingresar. Siempre debe quedar un administrador activo; no puedes desactivar tu propia cuenta ni quitarte ese rol.</p></CardContent></Card>{notice ? <p role="status" className="rounded-xl bg-primary/5 p-4 text-sm text-primary">{notice}</p> : null}{!activation ? <ErrorMessage message={error} /> : null}<Card className="gap-0 overflow-hidden py-0 shadow-none"><CardContent className="p-0"><div className="grid gap-3 border-b border-border p-4 sm:grid-cols-[1fr_210px]"><div className="relative"><Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" /><Input className={`${controlClass} pl-10`} aria-label="Buscar usuarios" placeholder="Buscar nombre o correo…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><select className={controlClass} aria-label="Estado de cuenta" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todas las cuentas</option><option value="active">Solo activas</option><option value="inactive">Solo inactivas</option></select></div><Feedback loading={users.loading} error={users.error} retry={() => void users.refresh()} />{!users.loading && !users.error ? filtered.length ? <div className="overflow-x-auto"><table className="w-full min-w-[690px] text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Usuario</th><th className="px-5 py-3 font-medium">Correo de acceso</th><th className="px-5 py-3 font-medium">Rol</th><th className="px-5 py-3 font-medium">Estado</th><th className="px-5 py-3 text-right font-medium">Acciones</th></tr></thead><tbody>{filtered.map((account) => <tr key={account.id} className="border-t border-border"><td className="px-5 py-4 font-medium">{account.name}{account.id === user.id ? <span className="mt-1 block text-xs font-normal text-muted-foreground">Tu cuenta</span> : null}</td><td className="px-5 py-4 text-muted-foreground">{account.email}</td><td className="px-5 py-4">{roleNames[account.role]}</td><td className="px-5 py-4"><Badge variant="secondary" className={account.active ? 'bg-primary/10 text-primary' : ''}>{account.active ? 'Activa' : 'Inactiva'}</Badge></td><td className="px-5 py-4"><div className="flex justify-end gap-1"><Button variant="ghost" className="min-h-11 min-w-11" aria-label={`Editar ${account.name}`} onClick={() => setEditor(account)}><Pencil /></Button><Button variant="ghost" className="min-h-11 min-w-11" aria-label={`Cambiar contraseña de ${account.name}`} onClick={() => setPasswordEditor(account)}><KeyRound /></Button><Button variant="ghost" className="min-h-11 min-w-11" disabled={account.id === user.id} aria-label={`${account.active ? 'Desactivar' : 'Reactivar'} ${account.name}`} onClick={() => { setError(''); setActivation(account); }}>{account.active ? <UserRoundX /> : <UserRoundCheck />}</Button></div></td></tr>)}</tbody></table></div> : <EmptyState title="No encontramos usuarios" detail="Prueba otro nombre, correo o estado de cuenta." /> : null}</CardContent></Card>{editor !== null ? <UserEditor account={editor === 'new' ? null : editor} currentUser={user} onClose={() => setEditor(null)} onSaved={saved} /> : null}{passwordEditor ? <PasswordEditor account={passwordEditor} onClose={() => setPasswordEditor(null)} onSaved={saved} /> : null}{activation ? <ManagementDialog open title={activation.active ? 'Desactivar usuario' : 'Reactivar usuario'} detail={`${activation.name} · ${activation.email}`} onClose={() => { setActivation(null); setError(''); }} busy={busy}><ErrorMessage message={error} /><p className="text-sm leading-relaxed text-muted-foreground">{activation.active ? 'Esta cuenta perderá el acceso y se cerrarán sus sesiones. Sus ventas y movimientos permanecerán guardados.' : 'Esta cuenta podrá volver a ingresar con su contraseña y el rol asignado.'}</p><div className="flex justify-end gap-2"><Button variant="outline" className={actionClass} disabled={busy} onClick={() => { setActivation(null); setError(''); }}>Cancelar</Button><Button className={actionClass} disabled={busy} onClick={() => void toggleActive()}>{busy ? 'Guardando…' : activation.active ? 'Desactivar cuenta' : 'Reactivar cuenta'}</Button></div></ManagementDialog> : null}</div>;
}
