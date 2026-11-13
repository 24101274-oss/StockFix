export type Role = 'admin' | 'cashier';
export type LocationId = 'puesto' | 'almacen';
export type PaymentMethod = 'efectivo' | 'yape' | 'plin' | 'transferencia';
export type DocumentType = 'ticket' | 'boleta' | 'factura';
export interface User { id: string; name: string; email: string; role: Role; active: boolean }
export interface UserInput { name: string; email: string; role: Role; active: boolean }
export interface UserCreateInput extends UserInput { password: string }
export interface Presentation { id: string; label: string; units: number; priceCents: number }
export interface PresentationCount { presentationId: string | null; quantity: number }
export interface PresentationMinimum { presentationId: string | null; minimum: number }
export interface StockPresentationAlert { location: LocationId; presentationId: string | null; presentationLabel: string; quantity: number; minimum: number }
export interface Product {
  id: string; sku: string; name: string; brand: string; category: string;
  barcode: string | null; active: boolean; stock: Record<LocationId, number | null>;
  stockByPresentation?: Record<LocationId, PresentationCount[] | null>;
  minStockUnits?: number | null;
  minStockByPresentation?: PresentationMinimum[];
  presentations: Presentation[]; sourceNotes: string[];
}
export interface ProductInput {
  name: string; brand: string; category: string; barcode: string | null;
  active: boolean; presentations: Presentation[]; minStockUnits?: number | null; minStockByPresentation?: PresentationMinimum[];
}
export interface Customer {
  id: string; documentType: 'DNI' | 'RUC' | 'SIN_DOCUMENTO';
  document: string; name: string; address: string;
}
export type CustomerInput = Omit<Customer, 'id'>;
export interface DocumentLookupResult {
  documentType: 'DNI' | 'RUC'; document: string; name: string; address: string;
  source: 'registro_local' | 'api_peru'; customer?: Customer;
  cached?: boolean; fetchedAt?: string;
}
export interface DocumentLookupStatus {
  provider: 'api_peru'; configured: boolean; dniEnabled: boolean; rucEnabled: boolean;
}
export interface Supplier { id: string; ruc: string; name: string; address: string; phone: string }
export type SupplierInput = Omit<Supplier, 'id'>;
export interface SaleItemInput { productId: string; presentationId: string; quantity: number; location: LocationId }
export interface SaleItem extends SaleItemInput {
  name: string; presentationLabel: string; units: number; unitPriceCents: number; totalCents: number;
}
export interface SaleInput {
  idempotencyKey: string; documentType: DocumentType; customerId: string | null;
  paymentMethod: PaymentMethod; paidCents: number; items: SaleItemInput[];
}
export interface Sale {
  id: string; number: string; documentType: DocumentType; status: 'PRUEBA';
  createdAt: string; userName: string; customer: Customer | null;
  paymentMethod: PaymentMethod; totalCents: number; paidCents: number;
  changeCents: number; items: SaleItem[]; cancelled: boolean;
}
export interface PurchaseItemInput {
  productId: string; presentationId: string; quantity: number; unitCostCents: number | null;
}
export interface PurchaseInput {
  idempotencyKey: string; supplierId: string; document: string; location: LocationId;
  paymentMethod: PaymentMethod; paidFromCash: boolean; totalPaidCents: number | null;
  items: PurchaseItemInput[];
}
export interface Purchase extends PurchaseInput { id: string; number: string; createdAt: string; supplierName: string; userName: string }
export interface StockMovement {
  id: string; productId: string; productName: string; location: LocationId;
  quantityUnits: number; type: string; reason: string; createdAt: string; userName: string;
}
export interface CashMovement { id: string; type: 'ingreso' | 'egreso'; amountCents: number; reason: string; createdAt: string; userName: string }
export interface CashSession {
  id: string; openedAt: string; closedAt: string | null; openedBy: string;
  openingCents: number; expectedCents: number; countedCents: number | null;
  differenceCents: number | null; payments: Record<PaymentMethod, number>;
  movements: CashMovement[];
}
export interface Summary {
  todaySalesCents: number; todaySalesCount: number; productsCount: number;
  month: string; monthSalesCents: number; monthSalesCount: number;
  pendingProductsCount: number; lowStockCount: number; cashOpen: boolean;
  lowStock: { productId: string; name: string; sku: string; alerts: StockPresentationAlert[] }[];
  week: { date: string; totalCents: number }[];
  topProducts: { productId: string; name: string; totalCents: number; quantityUnits: number; salesCount: number }[];
}
export interface Settings {
  businessName: string; ruc: string; address: string;
  taxStatus: 'pending'; nubefactEnabled: false; mode: 'development';
}
