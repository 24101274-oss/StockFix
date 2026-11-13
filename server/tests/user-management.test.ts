import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ManagedUser, UserManagementResult } from '../../shared/users';
import { buildApp } from '../app';

const initialPassword = 'PruebaUsuario2026!';
let app: FastifyInstance;
let admin: ManagedUser;
let adminCookie: string;
let cashierCookie: string;
let nextUser = 0;

const request = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: unknown, cookie = adminCookie) => app.inject({ method, url: `/api${path}`, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
async function login(email: string, password = initialPassword, instance = app) {
  const response = await instance.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return { response, cookie: String(response.headers['set-cookie'] ?? '').split(';')[0] };
}
async function create(role: 'admin' | 'cashier' = 'cashier', active = true) {
  const response = await request('POST', '/users', { name: 'Usuario de prueba', email: `usuario-${++nextUser}@example.test`, role, active, password: initialPassword });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<ManagedUser>();
}
const profile = (user: ManagedUser, changes: Partial<ManagedUser> = {}) => ({ name: user.name, email: user.email, role: user.role, active: user.active, ...changes });

before(async () => {
  app = await buildApp({ seed: false, lookup: { token: '' } });
  const ownerLogin = await login('admin@stockfix.local', 'AdminDemo2026!');
  assert.equal(ownerLogin.response.statusCode, 200, ownerLogin.response.body);
  admin = ownerLogin.response.json<ManagedUser>();
  adminCookie = ownerLogin.cookie;
  const cashierLogin = await login('cajero@stockfix.local', 'CajeroDemo2026!');
  assert.equal(cashierLogin.response.statusCode, 200, cashierLogin.response.body);
  cashierCookie = cashierLogin.cookie;
});
after(async () => { await app.close(); });

test('user management requires an active administrator and does not expose password hashes', async () => {
  const operations = [
    ['GET', '/users', undefined],
    ['POST', '/users', { name: 'Otra cuenta', email: 'sinpermiso@example.test', role: 'cashier', password: initialPassword }],
    ['PATCH', `/users/${admin.id}`, profile(admin)],
    ['POST', `/users/${admin.id}/password`, { password: initialPassword }],
  ] as const;
  for (const [method, path, payload] of operations) {
    assert.equal((await request(method, path, payload, '')).statusCode, 401);
    assert.equal((await request(method, path, payload, cashierCookie)).statusCode, 403);
  }
  const users = (await request('GET', '/users')).json<ManagedUser[]>();
  assert.equal(users.length, 2);
  for (const user of users) {
    assert.deepEqual(Object.keys(user).sort(), ['active', 'email', 'id', 'name', 'role']);
    assert.equal(user.active, true);
  }
});

test('creation validates credentials, normalizes email and rejects case-insensitive duplicates', async () => {
  const input = { name: '  Cuenta nueva  ', email: 'MAYUSCULAS@example.test', role: 'cashier', password: initialPassword };
  for (const changes of [{ password: 'corta' }, { password: '            ' }, { role: 'owner' }, { email: 'correo inválido' }, { name: '  ' }, { passwordHash: 'inyectado' }]) {
    assert.equal((await request('POST', '/users', { ...input, ...changes })).statusCode, 400);
  }
  const response = await request('POST', '/users', input);
  assert.equal(response.statusCode, 200, response.body);
  const user = response.json<ManagedUser>();
  assert.equal(user.name, 'Cuenta nueva');
  assert.equal(user.email, 'mayusculas@example.test');
  assert.equal(user.active, true);
  assert.equal(Object.hasOwn(user, 'passwordHash'), false);
  assert.equal((await request('POST', '/users', { ...input, email: 'mayusculas@EXAMPLE.TEST' })).statusCode, 409);
  const signedIn = await login(user.email);
  assert.equal(signedIn.response.statusCode, 200);
  assert.equal((await request('GET', '/users', undefined, signedIn.cookie)).statusCode, 403);
  assert.equal((await request('PATCH', `/users/${user.id}`, profile(user, { email: admin.email }))).statusCode, 409);
});

test('name changes preserve sessions but role and email changes revoke all earlier sessions', async () => {
  const user = await create();
  const first = await login(user.email);
  const second = await login(user.email);
  const renamed = await request('PATCH', `/users/${user.id}`, profile(user, { name: 'Nombre corregido' }));
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json<UserManagementResult>().sessionsRevoked, false);
  assert.equal((await request('GET', '/auth/me', undefined, first.cookie)).json().name, 'Nombre corregido');
  const promoted = await request('PATCH', `/users/${user.id}`, profile(user, { name: 'Nombre corregido', role: 'admin' }));
  assert.equal(promoted.statusCode, 200, promoted.body);
  assert.equal(promoted.json<UserManagementResult>().sessionsRevoked, true);
  for (const cookie of [first.cookie, second.cookie]) assert.equal((await request('GET', '/auth/me', undefined, cookie)).statusCode, 401);
  const promotedLogin = await login(user.email);
  assert.equal((await request('GET', '/users', undefined, promotedLogin.cookie)).statusCode, 200);
  const newEmail = `renombrado-${++nextUser}@example.test`;
  const changedEmail = await request('PATCH', `/users/${user.id}`, profile(user, { name: 'Nombre corregido', role: 'admin', email: newEmail }));
  assert.equal(changedEmail.statusCode, 200, changedEmail.body);
  assert.equal((await request('GET', '/auth/me', undefined, promotedLogin.cookie)).statusCode, 401);
  assert.equal((await login(user.email)).response.statusCode, 401);
  assert.equal((await login(newEmail)).response.statusCode, 200);
  const renamedUser = changedEmail.json<UserManagementResult>().user;
  const downgraded = await request('PATCH', `/users/${user.id}`, profile(renamedUser, { role: 'cashier' }));
  assert.equal(downgraded.statusCode, 200, downgraded.body);
  const cashierLogin = await login(newEmail);
  assert.equal((await request('GET', '/users', undefined, cashierLogin.cookie)).statusCode, 403);
});

test('deactivation rejects login and revokes sessions; reactivation never restores old cookies', async () => {
  const user = await create();
  const signedIn = await login(user.email);
  const disabled = await request('PATCH', `/users/${user.id}`, profile(user, { active: false }));
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json<UserManagementResult>().sessionsRevoked, true);
  assert.equal((await request('GET', '/auth/me', undefined, signedIn.cookie)).statusCode, 401);
  assert.equal((await login(user.email)).response.statusCode, 401);
  assert.equal((await request('PATCH', `/users/${user.id}`, profile(user))).statusCode, 200);
  assert.equal((await request('GET', '/auth/me', undefined, signedIn.cookie)).statusCode, 401);
  assert.equal((await login(user.email)).response.statusCode, 200);
  const initiallyInactive = await create('cashier', false);
  assert.equal((await login(initiallyInactive.email)).response.statusCode, 401);
});

test('password replacement invalidates every session and preserves the user profile', async () => {
  const user = await create();
  const first = await login(user.email);
  const second = await login(user.email);
  assert.equal((await request('POST', `/users/${user.id}/password`, { password: 'corta' })).statusCode, 400);
  const changed = await request('POST', `/users/${user.id}/password`, { password: 'NuevaClaveUsuario2026!' });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(changed.json<UserManagementResult>(), { user, sessionsRevoked: true, selfSessionRevoked: false });
  for (const cookie of [first.cookie, second.cookie]) assert.equal((await request('GET', '/auth/me', undefined, cookie)).statusCode, 401);
  assert.equal((await login(user.email)).response.statusCode, 401);
  assert.equal((await login(user.email, 'NuevaClaveUsuario2026!')).response.statusCode, 200);
  assert.equal((await request('PATCH', '/users/no-existe', profile(user))).statusCode, 404);
  assert.equal((await request('POST', '/users/no-existe/password', { password: initialPassword })).statusCode, 404);
});

test('administrators cannot disable themselves or remove their own administrator role', async () => {
  for (const changes of [{ active: false }, { role: 'cashier' as const }]) {
    const response = await request('PATCH', `/users/${admin.id}`, profile(admin, changes));
    assert.equal(response.statusCode, 409, response.body);
  }
  const current = (await request('GET', '/auth/me')).json<ManagedUser>();
  assert.equal(current.active, true);
  assert.equal(current.role, 'admin');
});

test('concurrent administrators cannot keep managing accounts after their role is removed', async () => {
  const first = await create('admin');
  const second = await create('admin');
  const firstLogin = await login(first.email);
  const secondLogin = await login(second.email);
  const changes = await Promise.all([
    request('PATCH', `/users/${second.id}`, profile(second, { role: 'cashier' }), firstLogin.cookie),
    request('PATCH', `/users/${first.id}`, profile(first, { role: 'cashier' }), secondLogin.cookie),
  ]);
  assert.equal(changes.filter(response => response.statusCode === 200).length, 1, changes.map(response => response.body).join('\n'));
  assert.ok(changes.some(response => response.statusCode === 401 || response.statusCode === 403));
  const pair = (await request('GET', '/users')).json<ManagedUser[]>().filter(user => [first.id, second.id].includes(user.id));
  assert.deepEqual(pair.map(user => user.role).sort(), ['admin', 'cashier']);
  const removed = pair.find(user => user.role === 'cashier')!;
  const revokedCookie = removed.id === first.id ? firstLogin.cookie : secondLogin.cookie;
  assert.equal((await request('POST', '/users', { name: 'No autorizado', email: 'despues-del-cambio@example.test', role: 'admin', password: initialPassword }, revokedCookie)).statusCode, 401);
});

test('updating one own credentials reports expiration of the current session', async () => {
  const user = await create('admin');
  const signedIn = await login(user.email);
  const changed = await request('POST', `/users/${user.id}/password`, { password: 'ClavePropiaActualizada2026!' }, signedIn.cookie);
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json<UserManagementResult>().selfSessionRevoked, true);
  assert.equal((await request('GET', '/auth/me', undefined, signedIn.cookie)).statusCode, 401);
  const relogin = await login(user.email, 'ClavePropiaActualizada2026!');
  const ownEmail = await request('PATCH', `/users/${user.id}`, profile(user, { email: 'propia@example.test' }), relogin.cookie);
  assert.equal(ownEmail.statusCode, 200, ownEmail.body);
  assert.equal(ownEmail.json<UserManagementResult>().selfSessionRevoked, true);
  assert.equal((await request('GET', '/auth/me', undefined, relogin.cookie)).statusCode, 401);
});

test('database restart preserves custom owner credentials and never recreates a renamed demo admin', async () => {
  const testRoot = resolve('tmp');
  await mkdir(testRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(join(testRoot, 'stockfix-users-'));
  let persistent: FastifyInstance | undefined;
  const newPassword = 'ClavePersistente2026!';
  try {
    persistent = await buildApp({ dataDir: join(temporaryRoot, 'db'), seed: false, lookup: { token: '' } });
    const original = await login('admin@stockfix.local', 'AdminDemo2026!', persistent);
    assert.equal(original.response.statusCode, 200, original.response.body);
    const owner = original.response.json<ManagedUser>();
    const passwordChange = await persistent.inject({ method: 'POST', url: `/api/users/${owner.id}/password`, headers: { cookie: original.cookie }, payload: { password: newPassword } });
    assert.equal(passwordChange.statusCode, 200, passwordChange.body);
    const nextLogin = await login(owner.email, newPassword, persistent);
    const emailChange = await persistent.inject({ method: 'PATCH', url: `/api/users/${owner.id}`, headers: { cookie: nextLogin.cookie }, payload: profile(owner, { email: 'duena@example.test', name: 'Dueña' }) });
    assert.equal(emailChange.statusCode, 200, emailChange.body);
    await persistent.close();
    persistent = undefined;
    persistent = await buildApp({ dataDir: join(temporaryRoot, 'db'), seed: false, adminPassword: 'OtraClaveDeEntorno2026!', lookup: { token: '' } });
    assert.equal((await login('admin@stockfix.local', 'AdminDemo2026!', persistent)).response.statusCode, 401);
    assert.equal((await login('duena@example.test', 'OtraClaveDeEntorno2026!', persistent)).response.statusCode, 401);
    const restored = await login('duena@example.test', newPassword, persistent);
    assert.equal(restored.response.statusCode, 200, restored.response.body);
    const users = await persistent.inject({ method: 'GET', url: '/api/users', headers: { cookie: restored.cookie } });
    assert.equal(users.json<ManagedUser[]>().length, 2);
    assert.equal(users.json<ManagedUser[]>().some(user => user.email === 'admin@stockfix.local'), false);
    assert.equal(restored.response.json<ManagedUser>().id, owner.id);
  } finally {
    if (persistent) await persistent.close();
    const resolvedRoot = resolve(temporaryRoot);
    assert.ok(resolvedRoot.startsWith(testRoot + sep), 'La limpieza debe permanecer dentro del directorio temporal de pruebas');
    assert.match(resolvedRoot.slice(testRoot.length + 1), /^stockfix-users-/);
    await rm(resolvedRoot, { recursive: true, force: true });
  }
});
