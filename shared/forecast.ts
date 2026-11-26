import type { SyntheticManifest } from './demo-dataset';
import type { LocationId, Product, Sale } from './types';

export type ForecastLocation = LocationId | 'all';
export type ForecastMethod = 'last-month' | 'moving-average-3' | 'linear-trend' | 'seasonal-naive';
export const FORECAST_METHOD_LABELS: Record<ForecastMethod, string> = {
  'last-month': 'Último mes',
  'moving-average-3': 'Promedio de 3 meses',
  'linear-trend': 'Tendencia lineal',
  'seasonal-naive': 'Mismo mes del año anterior',
};
export interface ForecastQuery {
  cutoff: string;
  horizon: number;
  location: ForecastLocation;
  productId?: string;
}
export interface ForecastHistoryPoint { month: string; physicalUnits: number }
export interface ForecastPoint extends ForecastHistoryPoint {
  /** Rounded UP using the CURRENT presentation size. Not an exact pack count. */
  presentationQuantity: number;
}
export interface ForecastCandidate {
  method: ForecastMethod;
  mae: number;
  /** prediction minus observed demand; positive means overestimation. */
  bias: number;
}
export interface ForecastEvaluation {
  kind: 'rolling-one-step';
  months: string[];
  folds: number;
  mae: number;
  bias: number;
  baselineMae: number;
  candidates: ForecastCandidate[];
}
export interface ForecastSeries {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  presentationId: string;
  presentationLabel: string;
  unitsPerPresentation: number;
  status: 'ready' | 'insufficient-history';
  method: ForecastMethod | null;
  history: ForecastHistoryPoint[];
  partial: ForecastHistoryPoint | null;
  forecast: ForecastPoint[];
  evaluation: ForecastEvaluation | null;
  warnings: string[];
}
export interface ForecastReport {
  version: 1;
  query: ForecastQuery;
  timeZone: 'America/Lima';
  unit: 'physical-items';
  source: { kind: 'synthetic' | 'recorded'; label: string; datasetId: string | null; observedThrough: string | null };
  methodology: string;
  warnings: string[];
  series: ForecastSeries[];
}
export interface ForecastInput {
  products: Product[];
  sales: Sale[];
  manifest?: SyntheticManifest | null;
  query: ForecastQuery;
}
