import { sql } from 'drizzle-orm';
import { bigint, boolean, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { CashSession, Customer, Product, Purchase, Sale, StockMovement, Supplier, Role } from '../shared/types';

export const users = pgTable('users', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(),
  role: text('role').$type<Role>().notNull(), passwordHash: text('password_hash').notNull(),
  active: boolean('active').notNull().default(true),
});
export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(), userId: text('user_id').notNull().references(() => users.id),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
});
export const products = pgTable('products', { id: text('id').primaryKey(), data: jsonb('data').$type<Product>().notNull() });
export const customers = pgTable('customers', {
  id: text('id').primaryKey(), documentKey: text('document_key').unique(), data: jsonb('data').$type<Customer>().notNull(),
});
export const suppliers = pgTable('suppliers', {
  id: text('id').primaryKey(), ruc: text('ruc').notNull().unique(), data: jsonb('data').$type<Supplier>().notNull(),
});
export const sales = pgTable('sales', {
  id: text('id').primaryKey(), idempotencyKey: text('idempotency_key').notNull().unique(),
  requestHash: text('request_hash').notNull(), data: jsonb('data').$type<Sale>().notNull(),
});
export const purchases = pgTable('purchases', {
  id: text('id').primaryKey(), idempotencyKey: text('idempotency_key').notNull().unique(),
  requestHash: text('request_hash').notNull(), data: jsonb('data').$type<Purchase>().notNull(),
});
export const cashSessions = pgTable('cash_sessions', {
  id: text('id').primaryKey(), closed: boolean('closed').notNull().default(false),
  data: jsonb('data').$type<CashSession>().notNull(),
}, table => [uniqueIndex('one_open_register').on(table.closed).where(sql`${table.closed} = false`)]);
export const operationRequests = pgTable('operation_requests', {
  scope: text('scope').notNull(), idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  cashSessionId: text('cash_session_id').notNull().references(() => cashSessions.id),
}, table => [primaryKey({ columns: [table.scope, table.idempotencyKey] })]);
export const stockMovements = pgTable('stock_movements', {
  id: text('id').primaryKey(), data: jsonb('data').$type<StockMovement>().notNull(),
});
export const stockPackagingRequests = pgTable('stock_packaging_requests', {
  idempotencyKey: text('idempotency_key').primaryKey(), requestHash: text('request_hash').notNull(),
  productId: text('product_id').notNull().references(() => products.id),
});
export const stockTransferRequests = pgTable('stock_transfer_requests', {
  idempotencyKey: text('idempotency_key').primaryKey(), requestHash: text('request_hash').notNull(),
  productId: text('product_id').notNull().references(() => products.id),
});
export const counters = pgTable('counters', { name: text('name').primaryKey(), value: integer('value').notNull() });

// Kept alongside the typed Drizzle schema so the first local start needs no external database tooling.
export const initialSchema = `
CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, role text NOT NULL CHECK(role IN ('admin','cashier')), password_hash text NOT NULL, active boolean NOT NULL DEFAULT true);
ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at bigint NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS products (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS stock_packaging_requests (idempotency_key text PRIMARY KEY, request_hash text NOT NULL, product_id text NOT NULL REFERENCES products(id));
CREATE TABLE IF NOT EXISTS stock_transfer_requests (idempotency_key text PRIMARY KEY, request_hash text NOT NULL, product_id text NOT NULL REFERENCES products(id));
CREATE TABLE IF NOT EXISTS customers (id text PRIMARY KEY, document_key text UNIQUE, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS suppliers (id text PRIMARY KEY, ruc text NOT NULL UNIQUE, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS sales (id text PRIMARY KEY, idempotency_key text NOT NULL UNIQUE, request_hash text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS purchases (id text PRIMARY KEY, idempotency_key text NOT NULL UNIQUE, request_hash text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS cash_sessions (id text PRIMARY KEY, closed boolean NOT NULL DEFAULT false, data jsonb NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_register ON cash_sessions(closed) WHERE closed = false;
CREATE TABLE IF NOT EXISTS operation_requests (scope text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL, cash_session_id text NOT NULL REFERENCES cash_sessions(id), PRIMARY KEY(scope, idempotency_key));
CREATE TABLE IF NOT EXISTS stock_movements (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS counters (name text PRIMARY KEY, value integer NOT NULL);
`;
