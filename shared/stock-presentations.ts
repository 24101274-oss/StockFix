import type { Presentation } from './types';

export interface StockEquivalence {
  presentationId: string;
  label: string;
  unitsPerPresentation: number;
  completeCount: number;
  remainderUnits: number;
}

/** Alternative expressions of one stock balance, not separate packaging balances. */
export function describeStockEquivalences(total: number | null, presentations: readonly Presentation[]): StockEquivalence[] | null {
  if (total === null) return null;
  return presentations
    .filter(presentation => Number.isSafeInteger(presentation.units) && presentation.units > 0)
    .map(presentation => ({
      presentationId: presentation.id,
      label: presentation.label,
      unitsPerPresentation: presentation.units,
      completeCount: Math.floor(total / presentation.units),
      remainderUnits: total % presentation.units,
    }));
}
