import { PGlite, type Transaction } from '@electric-sql/pglite';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { SyntheticDataset, SyntheticLoadResult, SyntheticManifest, SyntheticOptions } from '../../shared/demo-dataset.js';
import { initialSchema } from '../schema.js';
import { generateSyntheticDataset, syntheticOperationalHash } from './dataset.js';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const markerSuffix = '.stockfix-synthetic.json';
const markerKind = 'stockfix-synthetic-dataset';

interface OwnershipMarker {
  kind: typeof markerKind;
  version: 1;
  status: 'initializing' | 'ready';
  dataDir: string;
  config: SyntheticOptions;
  dataSha256: string;
  manifest: SyntheticManifest;
  loadedAt: string;
}

async function statIfPresent(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Resolve existing ancestors as well as the final directory, so a junction or
// symlink in a parent cannot bypass protection of the original demo database.
async function canonicalPath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (!await statIfPresent(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error('No se pudo resolver el destino de la demo.');
    missing.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
  return resolve(await realpath(current), ...missing);
}

function isWithin(path: string, parent: string) {
  const delta = relative(parent, path);
  return delta === '' || (delta !== '..' && !delta.startsWith('..' + sep) && !isAbsolute(delta));
}

async function destinationPath(dataDir: string) {
  if (!dataDir.trim() || (/^[a-z][a-z\d+.-]*:\/\//i.test(dataDir) && !/^[a-z]:[\\/]/i.test(dataDir))) {
    throw new Error('La demo sintética requiere una carpeta local explícita.');
  }
  const requested = resolve(dataDir);
  const info = await statIfPresent(requested);
  if (info?.isSymbolicLink()) throw new Error('El destino no puede ser un enlace simbólico.');
  const actual = await canonicalPath(requested);
  const protectedDir = await canonicalPath(resolve(appRoot, 'data/demo-db'));
  if (actual === parse(actual).root || isWithin(actual, protectedDir)) {
    throw new Error('Destino protegido: la base data/demo-db existente no admite datos sintéticos. Usa otra carpeta.');
  }
  if (info && !info.isDirectory()) throw new Error('El destino debe ser una carpeta.');
  return actual;
}

async function readMarker(path: string): Promise<OwnershipMarker | null> {
  const info = await statIfPresent(path);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('El marcador del destino no es un archivo regular reconocido.');
  try {
    const marker = JSON.parse(await readFile(path, 'utf8')) as Partial<OwnershipMarker>;
    if (marker.kind !== markerKind || marker.version !== 1 || !['initializing', 'ready'].includes(marker.status ?? '') || typeof marker.dataDir !== 'string' || !marker.config || !marker.manifest || typeof marker.loadedAt !== 'string' || typeof marker.dataSha256 !== 'string') {
      throw new Error('invalid marker');
    }
    return marker as OwnershipMarker;
  } catch {
    throw new Error('El marcador del destino no es una importación sintética reconocida. No se abrió la base.');
  }
}

function checkMarker(marker: OwnershipMarker, dataDir: string, dataset: SyntheticDataset, options: SyntheticOptions) {
  if (marker.dataDir !== dataDir || !isDeepStrictEqual(marker.config, options) || marker.dataSha256 !== dataset.manifest.dataSha256 || !isDeepStrictEqual(marker.manifest, dataset.manifest)) {
    throw new Error('El destino pertenece a otra configuración o versión del dataset. Elige una carpeta nueva; no se sobrescribió la anterior.');
  }
  if (marker.status !== 'ready') {
    throw new Error('La inicialización anterior no terminó. Conserva ese destino para inspección y utiliza una carpeta nueva.');
  }
}

const operationalTables = ['products', 'suppliers', 'sales', 'purchases', 'stock_movements', 'cash_sessions'] as const;

function originalIds(dataset: SyntheticDataset) {
  return {
    products: dataset.products.map(row => row.id),
    suppliers: dataset.suppliers.map(row => row.id),
    sales: dataset.sales.map(row => row.data.id),
    purchases: dataset.purchases.map(row => row.data.id),
    stock_movements: dataset.stockMovements.map(row => row.id),
    cash_sessions: dataset.cashSessions.map(row => row.id),
  };
}

async function verifyExisting(db: PGlite, marker: OwnershipMarker, dataset: SyntheticDataset) {
  const result = await db.query<{ data: SyntheticManifest; loaded_at: string }>('SELECT data, loaded_at FROM demo_datasets WHERE id = $1', ['active']);
  if (result.rows.length !== 1 || !isDeepStrictEqual(result.rows[0].data, dataset.manifest) || result.rows[0].loaded_at !== marker.loadedAt) {
    throw new Error('La identidad del dataset en la base no coincide con su manifiesto. No se modificó el contenido.');
  }
  // Products, balances and cash may legitimately change after import. Preserve
  // them; verify the immutable import identity and original record membership
  // rather than replacing operational data with the generated starting state.
  const ids = originalIds(dataset);
  for (const table of operationalTables) {
    const result = await db.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table} WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`, [JSON.stringify(ids[table])]);
    if (result.rows[0].count !== ids[table].length) throw new Error(`Faltan registros originales de ${table}; no se reimportó ni reinició la base.`);
  }
  const counters = await db.query<{ name: string; value: number }>('SELECT name, value FROM counters WHERE name IN ($1, $2)', ['sale', 'purchase']);
  if ((counters.rows.find(row => row.name === 'sale')?.value ?? -1) < dataset.sales.length || (counters.rows.find(row => row.name === 'purchase')?.value ?? -1) < dataset.purchases.length) {
    throw new Error('Los contadores no conservan el histórico importado. No se modificó la base.');
  }
}

async function insertChunks<T>(tx: Transaction, rows: T[], sql: string) {
  for (let index = 0; index < rows.length; index += 200) await tx.query(sql, [JSON.stringify(rows.slice(index, index + 200))]);
}

async function insertDataset(tx: Transaction, dataset: SyntheticDataset, loadedAt: string) {
  await tx.exec(initialSchema);
  // This is a fresh, owned destination. Refuse any mixed business data even if
  // another process touched it between the filesystem check and initialization.
  for (const table of [...operationalTables, 'users', 'sessions', 'customers', 'counters', 'demo_datasets', 'operation_requests', 'stock_packaging_requests', 'stock_transfer_requests']) {
    const result = await tx.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`);
    if (result.rows[0].count !== 0) throw new Error('El destino contiene datos ajenos a esta carga. No se mezcló el histórico.');
  }
  await insertChunks(tx, dataset.products, "INSERT INTO products (id, data) SELECT value->>'id', value FROM jsonb_array_elements($1::jsonb)");
  await insertChunks(tx, dataset.suppliers, "INSERT INTO suppliers (id, ruc, data) SELECT value->>'id', value->>'ruc', value FROM jsonb_array_elements($1::jsonb)");
  await insertChunks(tx, dataset.sales, "INSERT INTO sales (id, idempotency_key, request_hash, data) SELECT value->'data'->>'id', value->>'idempotencyKey', value->>'requestHash', value->'data' FROM jsonb_array_elements($1::jsonb)");
  await insertChunks(tx, dataset.purchases, "INSERT INTO purchases (id, idempotency_key, request_hash, data) SELECT value->'data'->>'id', value->>'idempotencyKey', value->>'requestHash', value->'data' FROM jsonb_array_elements($1::jsonb)");
  await insertChunks(tx, dataset.stockMovements, "INSERT INTO stock_movements (id, data) SELECT value->>'id', value FROM jsonb_array_elements($1::jsonb)");
  await insertChunks(tx, dataset.cashSessions, "INSERT INTO cash_sessions (id, closed, data) SELECT value->>'id', (value->>'closedAt') IS NOT NULL, value FROM jsonb_array_elements($1::jsonb)");
  await tx.query('INSERT INTO counters (name, value) VALUES ($1, $2), ($3, $4)', ['sale', dataset.sales.length, 'purchase', dataset.purchases.length]);
  await tx.query('INSERT INTO demo_datasets (id, data, loaded_at) VALUES ($1, $2::jsonb, $3)', ['active', JSON.stringify(dataset.manifest), loadedAt]);
}

/** Import only into a fresh, explicitly owned local demo database. */
export async function loadSyntheticDemo(dataDir: string, options: SyntheticOptions): Promise<SyntheticLoadResult> {
  const dataset = generateSyntheticDataset(options);
  if (syntheticOperationalHash(dataset) !== dataset.manifest.dataSha256) throw new Error('El hash del dataset generado no coincide con su manifiesto.');
  const destination = await destinationPath(dataDir);
  const manifestPath = destination + markerSuffix;
  const existing = await readMarker(manifestPath);
  if (existing) {
    checkMarker(existing, destination, dataset, options);
    const info = await statIfPresent(destination);
    if (!info?.isDirectory() || !(await readdir(destination)).length) throw new Error('El marcador existe pero falta la base importada. No se recreó automáticamente.');
    const db = new PGlite(destination);
    try {
      await db.waitReady;
      await verifyExisting(db, existing, dataset);
      return { action: 'unchanged', manifest: dataset.manifest, dataDir: destination, manifestPath };
    } finally { await db.close(); }
  }
  if (await statIfPresent(destination) && (await readdir(destination)).length) {
    throw new Error('El destino contiene archivos o una base no reconocida. No se abrió; elige una carpeta vacía nueva.');
  }
  await mkdir(dirname(destination), { recursive: true });
  const loadedAt = new Date().toISOString();
  const marker: OwnershipMarker = { kind: markerKind, version: 1, status: 'initializing', dataDir: destination, config: { ...options }, dataSha256: dataset.manifest.dataSha256, manifest: dataset.manifest, loadedAt };
  let handle: FileHandle;
  try { handle = await open(manifestPath, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Otra carga obtuvo este destino. Espera a que termine y vuelve a consultar.');
    throw error;
  }
  let db: PGlite | undefined;
  try {
    await handle.writeFile(JSON.stringify(marker, null, 2), 'utf8');
    await handle.sync();
    if (await statIfPresent(destination) && (await readdir(destination)).length) throw new Error('El destino cambió durante la preparación. Se conserva sin importar; utiliza otra carpeta.');
    db = new PGlite(destination);
    await db.waitReady;
    await db.transaction(tx => insertDataset(tx, dataset, loadedAt));
    await db.close();
    db = undefined;
    const ready = JSON.stringify({ ...marker, status: 'ready' }, null, 2);
    await handle.write(ready, 0, 'utf8');
    await handle.truncate(Buffer.byteLength(ready));
    await handle.sync();
    return { action: 'created', manifest: dataset.manifest, dataDir: destination, manifestPath };
  } finally {
    try { if (db) await db.close(); }
    finally { await handle.close(); }
  }
}
