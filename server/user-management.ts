import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from '../shared/types';
import type { ManagedUser, UserManagementResult } from '../shared/users';
import * as schema from './schema';

type UsersDb = PgliteDatabase<typeof schema>;
type UsersTx = Parameters<Parameters<UsersDb['transaction']>[0]>[0];
export interface UserManagementDependencies {
  db: UsersDb; atomic: <T>(action: (tx: UsersTx) => Promise<T>) => Promise<T>;
  requireAdmin: (request: FastifyRequest) => Promise<User>;
  hashPassword: (password: string) => Promise<string>;
  fail: (message: string, statusCode?: number) => never;
}
const name = z.string().trim().min(1, 'Ingresa el nombre del usuario.').max(100);
const email = z.email('Ingresa un correo válido.').max(200).transform((value) => value.toLowerCase());
const role = z.enum(['admin', 'cashier']);
const password = z.string().min(12, 'La contraseña debe tener al menos 12 caracteres.').max(200).refine((value) => value.trim().length > 0, 'Ingresa una contraseña válida.');
const createSchema = z.object({ name, email, role, password, active: z.boolean().default(true) }).strict();
const updateSchema = z.object({ name, email, role, active: z.boolean() }).strict();
const passwordSchema = z.object({ password }).strict();
const publicUser = (row: typeof schema.users.$inferSelect): ManagedUser => ({ id: row.id, name: row.name, email: row.email, role: row.role, active: row.active });

export function registerUserManagement(app: FastifyInstance, dependencies: UserManagementDependencies): void {
  const { db, atomic, requireAdmin, hashPassword, fail } = dependencies;
  async function currentAdmin(tx: UsersTx, actor: User) {
    const [row] = await tx.select().from(schema.users).where(eq(schema.users.id, actor.id)).limit(1);
    if (!row?.active || row.role !== 'admin') fail('Tu cuenta ya no tiene permiso para administrar usuarios.', 403);
  }
  app.get('/api/users', async (request) => {
    await requireAdmin(request);
    return (await db.select().from(schema.users)).map(publicUser).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  });
  app.post('/api/users', async (request) => {
    const actor = await requireAdmin(request);
    const input = createSchema.parse(request.body);
    const passwordHash = await hashPassword(input.password);
    return atomic(async (tx) => {
      await currentAdmin(tx, actor);
      if ((await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, input.email)).limit(1)).length) fail('Ya existe una cuenta con este correo.', 409);
      const row = { id: randomUUID(), name: input.name, email: input.email, role: input.role, active: input.active, passwordHash };
      await tx.insert(schema.users).values(row);
      return publicUser(row);
    });
  });
  app.patch('/api/users/:id', async (request): Promise<UserManagementResult> => {
    const actor = await requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = updateSchema.parse(request.body);
    return atomic(async (tx) => {
      await currentAdmin(tx, actor);
      const [current] = await tx.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
      if (!current) fail('Usuario no encontrado.', 404);
      if (id === actor.id && (!input.active || input.role !== 'admin')) fail('No puedes desactivar tu propia cuenta ni quitarte el rol de administrador.', 409);
      if (current.active && current.role === 'admin' && (!input.active || input.role !== 'admin')) {
        const admins = await tx.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.active, true), eq(schema.users.role, 'admin')));
        if (admins.length <= 1) fail('Debe permanecer al menos una cuenta administradora activa.', 409);
      }
      const [other] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, input.email)).limit(1);
      if (other && other.id !== id) fail('Ya existe una cuenta con este correo.', 409);
      const sessionsRevoked = current.email !== input.email || current.role !== input.role || (current.active && !input.active);
      await tx.update(schema.users).set(input).where(eq(schema.users.id, id));
      if (sessionsRevoked) await tx.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      return { user: publicUser({ ...current, ...input }), sessionsRevoked, selfSessionRevoked: id === actor.id && sessionsRevoked };
    });
  });
  app.post('/api/users/:id/password', async (request): Promise<UserManagementResult> => {
    const actor = await requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = passwordSchema.parse(request.body);
    const passwordHash = await hashPassword(input.password);
    return atomic(async (tx) => {
      await currentAdmin(tx, actor);
      const [current] = await tx.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
      if (!current) fail('Usuario no encontrado.', 404);
      await tx.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, id));
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      return { user: publicUser(current), sessionsRevoked: true, selfSessionRevoked: id === actor.id };
    });
  });
}
