import type { LocationId, PaymentMethod } from '../../shared/types';
const money = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });
export const soles = (cents: number) => money.format(cents / 100);
export const cents = (value: string) => Math.round(Number(value || 0) * 100);
export const dateTime = (value: string) => new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Lima' }).format(new Date(value));
const limaDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' });
export const dateInLima = (value: string | Date) => {
  const parts = limaDay.formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${read('year')}-${read('month')}-${read('day')}`;
};
export const locations: Record<LocationId, string> = { puesto: 'Puesto de venta', almacen: 'Almacén' };
export const paymentNames: Record<PaymentMethod, string> = { efectivo: 'Efectivo', yape: 'Yape', plin: 'Plin', transferencia: 'Transferencia' };
