import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CashSession, Customer, DocumentLookupResult, Product, Purchase, Sale, SaleItem, Settings, StockMovement, User } from '../shared/types';
import { getPackagingStock, normalizePresentationCounts } from '../shared/stock-packaging';
import { createDocumentLookup, DocumentLookupError, type DocumentLookupOptions } from './document-lookup';
import { buildSummary, registerReports } from './reports';
import { registerForecast } from './forecast/routes';
import { registerReplenishment } from './replenishment/routes';
import { registerUserManagement } from './user-management';
import { prepareProductPackaging, registerStockUnpacking } from './stock-unpack';
import * as schema from './schema';
import { adjustSchema, cashMovementSchema, closeCashSchema, customerSchema, isValidRuc, loginSchema, MAX_CENTS, openCashSchema, productSchema, purchaseSchema, saleSchema, supplierSchema, transferSchema } from './validation';

const scrypt = promisify(scryptCallback);
const SESSION_HOURS = 12;
const cookieName = 'stockfix_session';
const defaultPasswords = { admin: 'AdminDemo2026!', cashier: 'CajeroDemo2026!' };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }
function safeNumber(value: number, maximum = MAX_CENTS): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('El importe o la cantidad excede el límite permitido.');
  return value;
}
async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
async function verifyPassword(password: string, hash: string) {
  const [salt, encoded] = hash.split(':');
  const expected = Buffer.from(encoded ?? '', 'hex');
  const actual = await scrypt(password, salt ?? '', 64) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function publicUser(row: typeof schema.users.$inferSelect): User { return { id: row.id, name: row.name, email: row.email, role: row.role, active: row.active }; }

export interface AppOptions {
  dataDir?: string; seed?: Product[] | false; adminPassword?: string; cashierPassword?: string;
  allowedOrigins?: string[]; production?: boolean; serveStatic?: boolean;
  lookup?: DocumentLookupOptions;
}

export async function buildApp(options: AppOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? defaultPasswords.admin;
  const cashierPassword = options.cashierPassword ?? process.env.CASHIER_PASSWORD ?? defaultPasswords.cashier;
  if (production && (adminPassword === defaultPasswords.admin || cashierPassword === defaultPasswords.cashier || adminPassword.length < 12 || cashierPassword.length < 12 || !process.env.APP_ORIGIN)) {
    fail('Producción requiere ADMIN_PASSWORD y CASHIER_PASSWORD propios de al menos 12 caracteres, y APP_ORIGIN HTTPS.', 500);
  }
  if (production && !process.env.APP_ORIGIN?.startsWith('https://')) fail('APP_ORIGIN debe utilizar HTTPS en producción.', 500);
  const allowedOrigins = new Set(options.allowedOrigins ?? (process.env.APP_ORIGIN ? [process.env.APP_ORIGIN] : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3001', 'http://127.0.0.1:3001']));
  const localDataDir = options.dataDir && (!/^[a-z][a-z\d+.-]*:\/\//i.test(options.dataDir) || /^[a-z]:[\\/]/i.test(options.dataDir));
  // PGlite creates its own directory, but its filesystem adapter requires the
  // parent to exist. URI-backed and in-memory databases must not create folders.
  if (localDataDir) await mkdir(dirname(resolve(options.dataDir!)), { recursive: true });
  const pglite = new PGlite(options.dataDir);
  await pglite.waitReady;
  await pglite.exec(schema.initialSchema);
  const db = drizzle(pglite, { schema });
  // A production restart invalidates earlier cookies, including demonstration
  // sessions created before credentials were changed for deployment.
  if (production) await db.delete(schema.sessions);
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  // PGlite has one connection. Serializing a complete business operation prevents
  // interleaved read/write operations from consuming the same stock or open register.
  let writeTail: Promise<unknown> = Promise.resolve();
  function atomic<T>(action: (tx: Tx) => Promise<T>): Promise<T> {
    const run = writeTail.then(() => db.transaction(action));
    writeTail = run.catch(() => undefined);
    return run;
  }
  const initializeAccounts = !(await db.select({ id: schema.users.id }).from(schema.users).limit(1)).length;
  for (const account of [
    { email: 'admin@stockfix.local', name: 'Administradora', role: 'admin' as const, password: adminPassword },
    { email: 'cajero@stockfix.local', name: 'Cajero', role: 'cashier' as const, password: cashierPassword },
  ]) {
    const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, account.email)).limit(1);
    if (!existing && initializeAccounts) {
      await db.insert(schema.users).values({ id: randomUUID(), name: account.name, email: account.email, role: account.role, passwordHash: await hashPassword(account.password) });
    } else if (existing && account.password !== defaultPasswords[account.role] && await verifyPassword(defaultPasswords[account.role], existing.passwordHash)) {
      // Allow the initial deployment to replace public demo credentials. Later
      // restarts must preserve passwords changed through account management.
      await db.update(schema.users).set({ passwordHash: await hashPassword(account.password) }).where(eq(schema.users.id, existing.id));
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, existing.id));
    }
  }
  if (!(await db.select({ id: schema.products.id }).from(schema.products).limit(1)).length && options.seed !== false) {
    let seed = options.seed;
    if (!seed) {
      const file = fileURLToPath(new URL('./seed/catalog.json', import.meta.url));
      if (existsSync(file)) {
        const loaded: unknown = JSON.parse(await readFile(file, 'utf8'));
        seed = Array.isArray(loaded) ? loaded as Product[] : (loaded as { products: Product[] }).products;
      }
    }
    if (seed?.length) await atomic(async tx => {
      for (const product of seed) {
        const validated = productSchema.parse({ name: product.name, brand: product.brand, category: product.category, barcode: product.barcode, active: product.active, presentations: product.presentations, minStockUnits: product.minStockUnits, minStockByPresentation: product.minStockByPresentation });
        const record: Product = { ...product, ...validated, stock: product.stock ?? { puesto: null, almacen: null } };
        await tx.insert(schema.products).values({ id: record.id, data: record });
      }
    });
  }
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: false });
  const [datasetRecord] = await db.select().from(schema.demoDatasets).where(eq(schema.demoDatasets.id, 'active')).limit(1);
  const demoDataset = datasetRecord?.data ?? null;
  const documentLookup = createDocumentLookup(options.lookup);
  await app.register(cookie);
  app.addHook('onClose', async () => { await writeTail; await pglite.close(); });
  app.addHook('onSend', async (request, reply, payload) => {
    if (demoDataset && request.url.startsWith('/api/')) {
      reply.header('X-StockFix-Data-Origin', 'synthetic');
      reply.header('X-StockFix-Dataset-Id', demoDataset.id);
      const disposition = reply.getHeader('Content-Disposition');
      if (typeof disposition === 'string') {
        reply.header('Content-Disposition', disposition.replace(/filename="([^"]+)"/, 'filename="DATOS_SINTETICOS_DEMOSTRACION-$1"'));
      }
    }
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DocumentLookupError) {
      if (error.retryAfterSeconds) reply.header('Retry-After', error.retryAfterSeconds);
      return reply.code(error.statusCode).send({ message: error.message });
    }
    if (error instanceof z.ZodError) return reply.code(400).send({ message: error.issues[0]?.message ?? 'Datos inválidos.' });
    const code = Number((error as { statusCode?: number }).statusCode) || 500;
    if (code >= 500) app.log.error({ err: error }, 'Error de operación');
    return reply.code(code).send({ message: code >= 500 ? 'No se pudo completar la operación. Inténtalo nuevamente.' : (error as Error).message });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if ((origin && !allowedOrigins.has(origin)) || request.headers['sec-fetch-site'] === 'cross-site') fail('Origen no autorizado.', 403);
    }
  });
  async function requireUser(request: FastifyRequest): Promise<User> {
    const token = request.cookies[cookieName];
    if (!token) fail('Inicia sesión para continuar.', 401);
    const rows = await db.select({ user: schema.users }).from(schema.sessions)
      .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
      .where(and(eq(schema.sessions.tokenHash, digest(token)), gt(schema.sessions.expiresAt, Date.now()), eq(schema.users.active, true))).limit(1);
    if (!rows[0]) fail('La sesión venció. Inicia sesión nuevamente.', 401);
    return publicUser(rows[0].user);
  }
  async function requireAdmin(request: FastifyRequest): Promise<User> {
    const user = await requireUser(request);
    if (user.role !== 'admin') fail('Esta acción requiere una cuenta administradora.', 403);
    return user;
  }
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  app.post('/api/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const key = `${request.ip}:${input.email.toLowerCase()}`;
    const attempt = loginAttempts.get(key);
    if (attempt && attempt.resetAt > Date.now() && attempt.count >= 10) fail('Demasiados intentos. Espera 15 minutos.', 429);
    if (loginAttempts.size > 1000) for (const [storedKey, value] of loginAttempts) if (value.resetAt < Date.now()) loginAttempts.delete(storedKey);
    const [row] = await db.select().from(schema.users).where(eq(schema.users.email, input.email.toLowerCase())).limit(1);
    if (!row || !row.active || !await verifyPassword(input.password, row.passwordHash)) {
      loginAttempts.set(key, { count: attempt && attempt.resetAt > Date.now() ? attempt.count + 1 : 1, resetAt: attempt && attempt.resetAt > Date.now() ? attempt.resetAt : Date.now() + 900_000 });
      fail('Correo o contraseña incorrectos.', 401);
    }
    loginAttempts.delete(key);
    const token = randomBytes(32).toString('hex');
    const authenticated = await atomic(async tx => {
      // Credential checks run asynchronously. An administrator may have changed
      // this account before we acquired the write queue; never create a session
      // with credentials that have already been replaced or revoked.
      const [current] = await tx.select().from(schema.users).where(eq(schema.users.id, row.id)).limit(1);
      if (!current?.active || current.passwordHash !== row.passwordHash || current.email !== row.email || current.role !== row.role) {
        fail('La cuenta cambió durante el ingreso. Ingresa nuevamente con tus datos actuales.', 401);
      }
      const oldToken = request.cookies[cookieName];
      if (oldToken) await tx.delete(schema.sessions).where(eq(schema.sessions.tokenHash, digest(oldToken)));
      await tx.delete(schema.sessions).where(lt(schema.sessions.expiresAt, Date.now()));
      await tx.insert(schema.sessions).values({ tokenHash: digest(token), userId: row.id, expiresAt: Date.now() + SESSION_HOURS * 3_600_000 });
      return publicUser(current);
    });
    reply.setCookie(cookieName, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: production, maxAge: SESSION_HOURS * 3600 });
    return authenticated;
  });
  app.get('/api/auth/me', requireUser);
  app.get('/api/demo-dataset', async request => { await requireUser(request); return { dataset: demoDataset }; });
  app.get('/api/demo-dataset/manifest.json', async (request, reply) => {
    await requireUser(request);
    if (!demoDataset) fail('Esta base no tiene un histórico sintético identificado.', 404);
    return reply.header('Content-Disposition', 'attachment; filename="manifiesto-stockfix.json"').send(demoDataset);
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[cookieName];
    if (token) await atomic(tx => tx.delete(schema.sessions).where(eq(schema.sessions.tokenHash, digest(token))));
    reply.clearCookie(cookieName, { path: '/', httpOnly: true, sameSite: 'strict', secure: production });
    return { ok: true };
  });
  registerUserManagement(app, { db, atomic, requireAdmin, hashPassword, fail });
  registerReports(app, {
    requireAdmin,
    loadSales: async () => (await db.select().from(schema.sales)).map(row => row.data),
    loadProducts: async () => (await db.select().from(schema.products)).map(row => row.data),
    loadMovements: async () => (await db.select().from(schema.stockMovements)).map(row => row.data),
  });
  registerForecast(app, {
    requireAdmin,
    loadSales: async () => (await db.select().from(schema.sales)).map(row => row.data),
    loadProducts: async () => (await db.select().from(schema.products)).map(row => row.data),
    loadManifest: async () => demoDataset,
  });
  registerReplenishment(app, {
    requireAdmin,
    loadSales: async () => (await db.select().from(schema.sales)).map(row => row.data),
    loadProducts: async () => (await db.select().from(schema.products)).map(row => row.data),
    loadManifest: async () => demoDataset,
  });
  app.get('/api/health', async () => ({ ok: true, mode: 'development', fiscalEnabled: false }));
  const settings: Settings = { businessName: 'StockFix Académico', ruc: '', address: 'Caso académico ficticio', taxStatus: 'pending', nubefactEnabled: false, mode: 'development' };
  app.get('/api/settings', async request => { await requireUser(request); return settings; });
  app.post('/api/fiscal/emit', async request => { await requireAdmin(request); fail('Emisión electrónica desactivada. Los documentos actuales son pruebas y no se envían a SUNAT.', 409); });

  app.get('/api/products', async request => { await requireUser(request); return (await db.select().from(schema.products)).map(row => row.data).sort((a, b) => a.name.localeCompare(b.name, 'es')); });
  app.post('/api/products', async request => {
    await requireAdmin(request);
    const input = productSchema.parse(request.body);
    return atomic(async tx => {
      if (input.barcode) {
        const existing = await tx.select().from(schema.products).where(sql`${schema.products.data}->>'barcode' = ${input.barcode}`).limit(1);
        if (existing.length) fail('Ese código ya está asociado a otro producto.', 409);
      }
      const product: Product = { ...input, id: randomUUID(), sku: `P-${randomBytes(4).toString('hex').toUpperCase()}`, stock: { puesto: null, almacen: null }, sourceNotes: [] };
      await tx.insert(schema.products).values({ id: product.id, data: product });
      return product;
    });
  });
  app.patch('/api/products/:id', async request => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const input = productSchema.parse(request.body);
    return atomic(async tx => {
      const old = await getProduct(tx, id);
      if (input.barcode) {
        const matching = await tx.select().from(schema.products).where(sql`${schema.products.data}->>'barcode' = ${input.barcode}`);
        if (matching.some(x => x.id !== id)) fail('Ese código ya está asociado a otro producto.', 409);
      }
      const stockByPresentation = prepareProductPackaging(old, input.presentations);
      // Older clients omit the new field. Preserve still-valid thresholds and
      // prune removed or newly unit-sized packs rather than keep stale IDs.
      const minStockByPresentation = input.minStockByPresentation ?? old.minStockByPresentation?.filter(minimum => minimum.presentationId === null || input.presentations.some(item => item.id === minimum.presentationId && item.units > 1));
      const product = { ...old, ...input, ...(stockByPresentation ? { stockByPresentation } : {}), ...(minStockByPresentation ? { minStockByPresentation } : {}) };
      await tx.update(schema.products).set({ data: product }).where(eq(schema.products.id, id));
      return product;
    });
  });
  app.get('/api/customers', async request => { await requireUser(request); return (await db.select().from(schema.customers)).map(x => x.data); });
  app.post('/api/customers', async request => {
    await requireUser(request);
    const input = customerSchema.parse(request.body);
    return atomic(async tx => {
      const documentKey = input.documentType === 'SIN_DOCUMENTO' ? null : `${input.documentType}:${input.document}`;
      if (documentKey && (await tx.select().from(schema.customers).where(eq(schema.customers.documentKey, documentKey)).limit(1)).length) fail('Este cliente ya está registrado.', 409);
      const customer = { ...input, id: randomUUID() };
      await tx.insert(schema.customers).values({ id: customer.id, documentKey, data: customer });
      return customer;
    });
  });
  app.get('/api/suppliers', async request => { await requireAdmin(request); return (await db.select().from(schema.suppliers)).map(x => x.data); });
  app.post('/api/suppliers', async request => {
    await requireAdmin(request);
    const input = supplierSchema.parse(request.body);
    return atomic(async tx => {
      if ((await tx.select().from(schema.suppliers).where(eq(schema.suppliers.ruc, input.ruc)).limit(1)).length) fail('Este proveedor ya está registrado.', 409);
      const supplier = { ...input, id: randomUUID() };
      await tx.insert(schema.suppliers).values({ id: supplier.id, ruc: supplier.ruc, data: supplier });
      return supplier;
    });
  });
  app.get('/api/lookup/status', async request => { await requireUser(request); return documentLookup.status(); });
  app.get('/api/lookup/ruc/:ruc', async (request): Promise<DocumentLookupResult> => {
    const user = await requireUser(request);
    const { ruc } = request.params as { ruc: string };
    if (!isValidRuc(ruc)) fail('El RUC no tiene un formato válido.');
    const [supplier] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.ruc, ruc)).limit(1);
    const [customer] = await db.select().from(schema.customers).where(eq(schema.customers.documentKey, `RUC:${ruc}`)).limit(1);
    if (customer) return { documentType: 'RUC', document: ruc, name: customer.data.name, address: customer.data.address, source: 'registro_local', customer: customer.data };
    if (supplier) return { documentType: 'RUC', document: ruc, name: supplier.data.name, address: supplier.data.address, source: 'registro_local' };
    return documentLookup.lookup('RUC', ruc, user.id);
  });
  app.get('/api/lookup/dni/:dni', async (request): Promise<DocumentLookupResult> => {
    const user = await requireUser(request);
    const { dni } = request.params as { dni: string };
    if (!/^\d{8}$/.test(dni)) fail('El DNI debe tener 8 dígitos.');
    const [customer] = await db.select().from(schema.customers).where(eq(schema.customers.documentKey, `DNI:${dni}`)).limit(1);
    if (customer) return { documentType: 'DNI', document: dni, name: customer.data.name, address: customer.data.address, source: 'registro_local', customer: customer.data };
    return documentLookup.lookup('DNI', dni, user.id);
  });

  async function getProduct(tx: Tx, id: string): Promise<Product> {
    const [row] = await tx.select().from(schema.products).where(eq(schema.products.id, id)).limit(1);
    if (!row) fail('Producto no encontrado.', 404);
    return row.data;
  }
  async function getOpenCash(tx: Tx): Promise<CashSession> {
    const [row] = await tx.select().from(schema.cashSessions).where(eq(schema.cashSessions.closed, false)).limit(1);
    if (!row) fail('Abre la caja antes de registrar esta operación.', 409);
    return row.data;
  }
  async function saveCash(tx: Tx, cash: CashSession) { await tx.update(schema.cashSessions).set({ data: cash, closed: cash.closedAt !== null }).where(eq(schema.cashSessions.id, cash.id)); }
  async function nextNumber(tx: Tx, counter: string, prefix: string) {
    const [row] = await tx.insert(schema.counters).values({ name: counter, value: 1 })
      .onConflictDoUpdate({ target: schema.counters.name, set: { value: sql`${schema.counters.value} + 1` } }).returning();
    return `${prefix}-${String(row.value).padStart(6, '0')}`;
  }
  async function recordStock(tx: Tx, product: Product, location: 'puesto' | 'almacen', quantityUnits: number, type: string, reason: string, user: User) {
    const movement: StockMovement = { id: randomUUID(), productId: product.id, productName: product.name, location, quantityUnits, type, reason, createdAt: now(), userName: user.name };
    await tx.insert(schema.stockMovements).values({ id: movement.id, data: movement });
  }
  registerStockUnpacking(app, { atomic, requireAdmin, getProduct, recordStock, fail });
  function countedUnits(product: Product, input: { quantityUnits: number } | { counts: { presentationId: string | null; quantity: number }[] }, maximum: number) {
    if ('quantityUnits' in input) return safeNumber(input.quantityUnits, maximum);
    let total = 0;
    for (const line of input.counts) {
      const presentation = line.presentationId === null ? null : product.presentations.find(item => item.id === line.presentationId);
      if (line.presentationId !== null && !presentation) fail('La presentación cambió o ya no existe. Actualiza el producto antes de guardar el conteo.', 409);
      // Read the conversion from the current stored product inside the write
      // transaction; a browser cannot provide or override the unit multiplier.
      const units = presentation?.units ?? 1;
      total = safeNumber(total + safeNumber(units * line.quantity, maximum), maximum);
    }
    return total;
  }
  function confirmedPackaging(product: Product, location: 'puesto' | 'almacen') {
    const counts = getPackagingStock(product, location);
    if (Array.isArray(product.stockByPresentation?.[location]) && counts === null) {
      fail('El desglose de existencias cambió. Cuenta las presentaciones nuevamente antes de continuar.', 409);
    }
    return counts;
  }
  function changePackaging(product: Product, location: 'puesto' | 'almacen', presentationId: string | null, delta: number) {
    const counts = confirmedPackaging(product, location);
    if (counts === null) return;
    const line = counts.find(item => item.presentationId === presentationId);
    if (!line) fail('La presentación cambió. Cuenta las presentaciones nuevamente antes de continuar.', 409);
    if (line.quantity + delta < 0) fail(`No hay suficientes ${product.presentations.find(item => item.id === presentationId)?.label ?? 'unidades sueltas'} de ${product.name}. Abre un empaque o registra un nuevo conteo antes de continuar.`, 409);
    line.quantity = safeNumber(line.quantity + delta, 1_000_000_000);
    product.stockByPresentation = {
      puesto: product.stockByPresentation?.puesto ?? null,
      almacen: product.stockByPresentation?.almacen ?? null,
      [location]: counts,
    };
  }
  app.get('/api/stock/movements', async request => { await requireAdmin(request); return (await db.select().from(schema.stockMovements)).map(x => x.data).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); });
  app.post('/api/stock/adjust', async request => {
    const user = await requireAdmin(request);
    const input = adjustSchema.parse(request.body);
    return atomic(async tx => {
      const product = await getProduct(tx, input.productId);
      const before = product.stock[input.location];
      const quantityUnits = countedUnits(product, input, 1_000_000_000);
      product.stock[input.location] = quantityUnits;
      product.stockByPresentation = {
        puesto: product.stockByPresentation?.puesto ?? null,
        almacen: product.stockByPresentation?.almacen ?? null,
        [input.location]: 'counts' in input ? normalizePresentationCounts(product.presentations, input.counts) : null,
      };
      await tx.update(schema.products).set({ data: product }).where(eq(schema.products.id, product.id));
      await recordStock(tx, product, input.location, before === null ? quantityUnits : quantityUnits - before, before === null ? 'conteo_inicial' : 'ajuste', input.reason, user);
      return product;
    });
  });
  app.post('/api/stock/transfer', async request => {
    const user = await requireAdmin(request);
    const input = transferSchema.parse(request.body);
    const requestHash = input.idempotencyKey ? digest(JSON.stringify(input)) : null;
    return atomic(async tx => {
      if (input.idempotencyKey) {
        const [previous] = await tx.select().from(schema.stockTransferRequests).where(eq(schema.stockTransferRequests.idempotencyKey, input.idempotencyKey)).limit(1);
        if (previous) {
          if (previous.requestHash !== requestHash) fail('Este intento ya corresponde a otro traslado de mercadería.', 409);
          return getProduct(tx, previous.productId);
        }
      }
      const product = await getProduct(tx, input.productId);
      const quantityUnits = countedUnits(product, input, 1_000_000);
      if (quantityUnits === 0) fail('Ingresa una cantidad mayor que cero para trasladar.');
      const from = product.stock[input.from], to = product.stock[input.to];
      if (from === null || to === null) fail('Completa el conteo de ambas ubicaciones antes del traslado.', 409);
      if (from < quantityUnits) fail('Stock insuficiente para este traslado.', 409);
      if ('counts' in input) {
        const sourceCounts = confirmedPackaging(product, input.from), destinationCounts = confirmedPackaging(product, input.to);
        if (sourceCounts === null || destinationCounts === null) fail('Cuenta las presentaciones en ambas ubicaciones antes de trasladar empaques.', 409);
        // Single-unit presentations share the loose-unit bucket. Normalize
        // first so clients may use either the unit presentation or null.
        for (const line of normalizePresentationCounts(product.presentations, input.counts)) {
          const source = sourceCounts.find(item => item.presentationId === line.presentationId)!;
          const destination = destinationCounts.find(item => item.presentationId === line.presentationId)!;
          if (source.quantity < line.quantity) fail('No hay suficientes empaques de esa presentación para el traslado. Abre un empaque o registra un nuevo conteo.', 409);
          source.quantity -= line.quantity;
          destination.quantity = safeNumber(destination.quantity + line.quantity, 1_000_000_000);
        }
        product.stockByPresentation = { [input.from]: sourceCounts, [input.to]: destinationCounts } as NonNullable<Product['stockByPresentation']>;
      } else {
        // A legacy total does not identify physical packages. Preserve its
        // base-unit behavior and require a new breakdown instead of guessing.
        product.stockByPresentation = { puesto: null, almacen: null };
      }
      product.stock[input.from] = from - quantityUnits;
      product.stock[input.to] = safeNumber(to + quantityUnits, 1_000_000_000);
      await tx.update(schema.products).set({ data: product }).where(eq(schema.products.id, product.id));
      await recordStock(tx, product, input.from, -quantityUnits, 'traslado_salida', input.reason, user);
      await recordStock(tx, product, input.to, quantityUnits, 'traslado_entrada', input.reason, user);
      if (input.idempotencyKey) await tx.insert(schema.stockTransferRequests).values({ idempotencyKey: input.idempotencyKey, requestHash: requestHash!, productId: product.id });
      return product;
    });
  });
  app.get('/api/sales', async request => { await requireUser(request); return (await db.select().from(schema.sales)).map(x => x.data).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); });
  app.post('/api/sales', async request => {
    const user = await requireUser(request);
    const input = saleSchema.parse(request.body);
    const requestHash = digest(JSON.stringify(input));
    return atomic(async tx => {
      const [previous] = await tx.select().from(schema.sales).where(eq(schema.sales.idempotencyKey, input.idempotencyKey)).limit(1);
      if (previous) { if (previous.requestHash !== requestHash) fail('Este intento ya corresponde a otra venta.', 409); return previous.data; }
      const cash = await getOpenCash(tx);
      let customer: Customer | null = null;
      if (input.customerId) {
        const [row] = await tx.select().from(schema.customers).where(eq(schema.customers.id, input.customerId)).limit(1);
        if (!row) fail('Cliente no encontrado.', 404);
        customer = row.data;
      }
      if (input.documentType === 'factura' && (!customer || customer.documentType !== 'RUC' || !isValidRuc(customer.document) || !customer.name.trim())) fail('La factura de prueba requiere un cliente con RUC y razón social.');
      const items: SaleItem[] = [];
      const changed = new Map<string, Product>();
      for (const line of input.items) {
        const product = changed.get(line.productId) ?? await getProduct(tx, line.productId);
        const presentation = product.presentations.find(x => x.id === line.presentationId);
        if (!product.active || !presentation) fail('El producto o su presentación no está habilitado.');
        // Existing databases may contain prices saved before product validation
        // required a positive amount. Reject the sale until an admin corrects it.
        if (!Number.isSafeInteger(presentation.priceCents) || presentation.priceCents <= 0 || presentation.priceCents > MAX_CENTS) fail(`Corrige el precio de ${product.name}: debe ser mayor que cero y estar dentro del límite permitido.`, 409);
        const units = safeNumber(presentation.units * line.quantity, 1_000_000_000);
        const current = product.stock[line.location];
        if (current === null) fail(`Completa el conteo de ${product.name} en ${line.location} antes de vender.`, 409);
        if (current < units) fail(`Stock insuficiente de ${product.name} en ${line.location}.`, 409);
        changePackaging(product, line.location, presentation.units === 1 ? null : line.presentationId, -line.quantity);
        product.stock[line.location] = current - units;
        changed.set(product.id, product);
        items.push({ ...line, name: product.name, presentationLabel: presentation.label, units, unitPriceCents: presentation.priceCents, totalCents: safeNumber(presentation.priceCents * line.quantity) });
      }
      const totalCents = safeNumber(items.reduce((sum, item) => sum + item.totalCents, 0));
      if (input.paymentMethod === 'efectivo' ? input.paidCents < totalCents : input.paidCents !== totalCents) fail(input.paymentMethod === 'efectivo' ? 'El efectivo recibido no cubre la venta.' : 'El cobro digital debe coincidir con el total de la venta.');
      const sale: Sale = { id: randomUUID(), number: await nextNumber(tx, 'sale', 'PR'), documentType: input.documentType, status: 'PRUEBA', createdAt: now(), userName: user.name, customer, paymentMethod: input.paymentMethod, totalCents, paidCents: input.paidCents, changeCents: input.paidCents - totalCents, items, cancelled: false };
      for (const product of changed.values()) await tx.update(schema.products).set({ data: product }).where(eq(schema.products.id, product.id));
      for (const item of items) await recordStock(tx, changed.get(item.productId)!, item.location, -item.units, 'venta', sale.number, user);
      cash.payments[input.paymentMethod] = safeNumber(cash.payments[input.paymentMethod] + totalCents);
      if (input.paymentMethod === 'efectivo') cash.expectedCents = safeNumber(cash.expectedCents + totalCents);
      await saveCash(tx, cash);
      await tx.insert(schema.sales).values({ id: sale.id, idempotencyKey: input.idempotencyKey, requestHash, data: sale });
      return sale;
    });
  });
  app.get('/api/purchases', async request => { await requireAdmin(request); return (await db.select().from(schema.purchases)).map(x => x.data).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); });
  app.post('/api/purchases', async request => {
    const user = await requireAdmin(request);
    const input = purchaseSchema.parse(request.body);
    const requestHash = digest(JSON.stringify(input));
    return atomic(async tx => {
      const [previous] = await tx.select().from(schema.purchases).where(eq(schema.purchases.idempotencyKey, input.idempotencyKey)).limit(1);
      if (previous) { if (previous.requestHash !== requestHash) fail('Este intento ya corresponde a otra compra.', 409); return previous.data; }
      const [supplier] = await tx.select().from(schema.suppliers).where(eq(schema.suppliers.id, input.supplierId)).limit(1);
      if (!supplier) fail('Proveedor no encontrado.', 404);
      if (input.paidFromCash && (input.paymentMethod !== 'efectivo' || input.totalPaidCents === null || input.totalPaidCents <= 0)) fail('El pago desde caja requiere efectivo y un importe positivo confirmado.');
      const cash = input.paidFromCash ? await getOpenCash(tx) : null;
      if (cash && cash.expectedCents < input.totalPaidCents!) fail('La caja no tiene efectivo suficiente para este pago.', 409);
      const productsToSave = new Map<string, Product>();
      for (const item of input.items) {
        const product = productsToSave.get(item.productId) ?? await getProduct(tx, item.productId);
        const presentation = product.presentations.find(p => p.id === item.presentationId);
        if (!product.active || !presentation) fail('El producto o su presentación no está habilitado.');
        const current = product.stock[input.location];
        if (current === null) fail(`Completa el conteo de ${product.name} en ${input.location} antes de recibir.`, 409);
        changePackaging(product, input.location, presentation.units === 1 ? null : item.presentationId, item.quantity);
        product.stock[input.location] = safeNumber(current + presentation.units * item.quantity, 1_000_000_000);
        productsToSave.set(product.id, product);
      }
      if (input.items.every(item => item.unitCostCents !== null) && input.totalPaidCents !== null) {
        const calculated = safeNumber(input.items.reduce((sum, item) => sum + item.unitCostCents! * item.quantity, 0));
        if (calculated !== input.totalPaidCents) fail('El total pagado no coincide con los costos de los productos.');
      }
      const purchase: Purchase = { ...input, id: randomUUID(), number: await nextNumber(tx, 'purchase', 'CP'), createdAt: now(), supplierName: supplier.data.name, userName: user.name };
      for (const product of productsToSave.values()) await tx.update(schema.products).set({ data: product }).where(eq(schema.products.id, product.id));
      for (const item of input.items) {
        const product = productsToSave.get(item.productId)!;
        await recordStock(tx, product, input.location, product.presentations.find(x => x.id === item.presentationId)!.units * item.quantity, 'compra', purchase.number, user);
      }
      if (cash) {
        cash.expectedCents -= input.totalPaidCents!;
        cash.movements.push({ id: randomUUID(), type: 'egreso', amountCents: input.totalPaidCents!, reason: `Compra ${purchase.number}`, createdAt: now(), userName: user.name });
        await saveCash(tx, cash);
      }
      await tx.insert(schema.purchases).values({ id: purchase.id, idempotencyKey: input.idempotencyKey, requestHash, data: purchase });
      return purchase;
    });
  });
  app.get('/api/cash', async request => {
    await requireUser(request);
    const [row] = await db.select().from(schema.cashSessions).where(eq(schema.cashSessions.closed, false)).limit(1);
    return row?.data ?? null;
  });
  app.get('/api/cash/history', async request => { await requireUser(request); return (await db.select().from(schema.cashSessions)).map(x => x.data).sort((a, b) => b.openedAt.localeCompare(a.openedAt)); });
  app.post('/api/cash/open', async request => {
    const user = await requireUser(request);
    const input = openCashSchema.parse(request.body);
    return atomic(async tx => {
      if ((await tx.select().from(schema.cashSessions).where(eq(schema.cashSessions.closed, false)).limit(1)).length) fail('Ya existe una caja abierta.', 409);
      const cash: CashSession = { id: randomUUID(), openedAt: now(), closedAt: null, openedBy: user.name, openingCents: input.openingCents, expectedCents: input.openingCents, countedCents: null, differenceCents: null, payments: { efectivo: 0, yape: 0, plin: 0, transferencia: 0 }, movements: [] };
      await tx.insert(schema.cashSessions).values({ id: cash.id, closed: false, data: cash });
      return cash;
    });
  });
  app.post('/api/cash/movements', async request => {
    const user = await requireUser(request);
    const input = cashMovementSchema.parse(request.body);
    const requestHash = digest(JSON.stringify(input));
    return atomic(async tx => {
      const [previous] = await tx.select().from(schema.operationRequests).where(and(eq(schema.operationRequests.scope, 'cash-movement'), eq(schema.operationRequests.idempotencyKey, input.idempotencyKey))).limit(1);
      if (previous) {
        if (previous.requestHash !== requestHash) fail('Este intento ya corresponde a otro movimiento de caja.', 409);
        const [session] = await tx.select().from(schema.cashSessions).where(eq(schema.cashSessions.id, previous.cashSessionId)).limit(1);
        if (!session) fail('No se pudo recuperar la sesión vinculada al movimiento.', 500);
        return session.data;
      }
      const cash = await getOpenCash(tx);
      if (input.type === 'egreso' && cash.expectedCents < input.amountCents) fail('La caja no tiene efectivo suficiente para este egreso.', 409);
      cash.expectedCents = safeNumber(cash.expectedCents + (input.type === 'ingreso' ? input.amountCents : -input.amountCents));
      cash.movements.push({ type: input.type, amountCents: input.amountCents, reason: input.reason, id: randomUUID(), createdAt: now(), userName: user.name });
      await saveCash(tx, cash);
      await tx.insert(schema.operationRequests).values({ scope: 'cash-movement', idempotencyKey: input.idempotencyKey, requestHash, cashSessionId: cash.id });
      return cash;
    });
  });
  app.post('/api/cash/close', async request => {
    await requireUser(request);
    const input = closeCashSchema.parse(request.body);
    return atomic(async tx => {
      const cash = await getOpenCash(tx);
      cash.countedCents = input.countedCents;
      cash.differenceCents = input.countedCents - cash.expectedCents;
      cash.closedAt = now();
      await saveCash(tx, cash);
      return cash;
    });
  });
  app.get('/api/summary', async request => {
    await requireAdmin(request);
    const allSales = (await db.select().from(schema.sales)).map(x => x.data);
    const allProducts = (await db.select().from(schema.products)).map(x => x.data);
    const cashOpen = (await db.select().from(schema.cashSessions).where(eq(schema.cashSessions.closed, false)).limit(1)).length > 0;
    return buildSummary(allSales, allProducts, cashOpen);
  });
  if (options.serveStatic && existsSync(resolve('dist'))) {
    await app.register(staticPlugin, { root: resolve('dist'), prefix: '/' });
    app.setNotFoundHandler(async (request, reply: FastifyReply) => {
      if (request.url.startsWith('/api/') || !request.headers.accept?.includes('text/html')) return reply.code(404).send({ message: 'Ruta no encontrada.' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
