import type { SyntheticManifest } from './demo-dataset';
import type { ForecastReport } from './forecast';
import type { LocationId, Product } from './types';

/** Closed packages by ID; null is the ONE shared loose-unit pool. */
export interface PlanningQuantity { puesto: number; almacen: number }
export interface PlanningStock { puesto: number | null; almacen: number | null }
export interface ScenarioReceipt {
  id: string;
  productId: string;
  presentationId: string | null;
  location: LocationId;
  quantity: number;
  expectedOn: string;
  status: 'pending' | 'received' | 'cancelled';
}
export interface BridgeDemand {
  productId: string;
  presentationId: string | null;
  location: LocationId;
  /** Explicit scenario consumption before the first projected month. */
  quantity: number;
}
export interface ReplenishmentScenario {
  horizon: number;
  leadTimeDays: number;
  reservePercent: number;
  productId?: string;
  receipts: ScenarioReceipt[];
  bridgeDemand: BridgeDemand[];
}
export interface ReceiptDisposition {
  id: string;
  status: 'scheduled' | 'received-excluded' | 'cancelled-excluded' | 'overdue-excluded' | 'outside-horizon' | 'outside-filter';
  eligibleMonth: string | null;
  note: string;
}
export interface ReplenishmentMonth {
  month: string;
  needBy: string;
  orderBy: string;
  earliestArrivalIfOrderedToday: string;
  /** Current month opening assumes earlier recommendations were followed. */
  opening: PlanningQuantity;
  receipts: PlanningQuantity;
  available: PlanningQuantity;
  demandPhysicalUnits: PlanningQuantity;
  /** ceil(physical demand / current package size), per location. */
  demand: PlanningQuantity;
  reserve: PlanningQuantity;
  transferFromWarehouse: number;
  suggestedPurchase: PlanningQuantity;
  closingWithoutThisPurchase: PlanningQuantity;
  uncoveredDemand: PlanningQuantity;
  /** Hypothetical only: suggested purchases arrive by needBy. */
  closingIfRecommendations: PlanningQuantity;
  timingRisk: boolean;
  warnings: string[];
}
export interface ReplenishmentItem {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  presentationId: string | null;
  presentationLabel: string;
  sourcePresentationIds: string[];
  unitsPerPresentation: number;
  quantityUnit: 'closed-packages' | 'loose-pieces';
  status: 'ready' | 'unknown-stock' | 'insufficient-history' | 'quantity-limit';
  initialStock: PlanningStock;
  bridgeDemand: PlanningQuantity;
  bridgeUncovered: PlanningStock;
  afterBridge: PlanningStock;
  months: ReplenishmentMonth[];
  warnings: string[];
}
export interface ReplenishmentPlan {
  version: 1;
  asOfDate: string;
  firstMonth: string;
  timeZone: 'America/Lima';
  scenario: ReplenishmentScenario;
  source: ForecastReport['source'];
  assumptions: string[];
  receiptDispositions: ReceiptDisposition[];
  warnings: string[];
  items: ReplenishmentItem[];
}
export interface ReplenishmentReport extends ReplenishmentPlan {
  /** Export rejects stale plans after business data or the Lima date changes. */
  snapshot: string;
}
export interface ReplenishmentInput {
  asOfDate: string;
  products: Product[];
  forecasts: { puesto: ForecastReport; almacen: ForecastReport };
  manifest?: SyntheticManifest | null;
  scenario: ReplenishmentScenario;
}
