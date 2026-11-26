import type { CashSession, Product, Purchase, Sale, StockMovement, Supplier } from './types';

export const SYNTHETIC_DATA_LABEL = 'DATOS SINTÉTICOS DE DEMOSTRACIÓN';
export interface SyntheticOptions {
  seed: string;
  /** Inclusive calendar date in America/Lima, YYYY-MM-DD. */
  asOfDate: string;
  /** Complete months before the current partial month. */
  months: number;
}
export interface SyntheticManifest {
  id: string;
  kind: 'synthetic';
  label: typeof SYNTHETIC_DATA_LABEL;
  version: 1;
  seed: string;
  asOfDate: string;
  timeZone: 'America/Lima';
  historyStart: string;
  lastCompleteMonth: string;
  completeMonths: number;
  observedThrough: string;
  units: 'physical-items';
  coverage: { productId: string; introducedOn: string; observedFrom: string; observedThrough: string; pattern: string }[];
  counts: { products: number; sales: number; purchases: number; stockMovements: number; cashSessions: number };
  /** SHA-256 of the operational arrays, in their generated order. */
  dataSha256: string;
}
export interface SyntheticOperation<T> { data: T; idempotencyKey: string; requestHash: string }
export interface SyntheticDataset {
  manifest: SyntheticManifest;
  products: Product[];
  suppliers: Supplier[];
  sales: SyntheticOperation<Sale>[];
  purchases: SyntheticOperation<Purchase>[];
  stockMovements: StockMovement[];
  cashSessions: CashSession[];
}
export interface SyntheticLoadResult {
  action: 'created' | 'unchanged';
  manifest: SyntheticManifest;
  dataDir: string;
  manifestPath: string;
}
