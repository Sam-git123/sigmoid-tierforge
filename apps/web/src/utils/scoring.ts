import type { ScoringInput } from '../api/tierforge';

export const defaultScoringInput: ScoringInput = {
  footfallBar: '15000',
  revenueBar: '150000',
  sizeBar: '8000',
  footfallWeight: '50',
  revenueWeight: '30',
  sizeWeight: '20',
  largeThreshold: '70',
  mediumThreshold: '40',
};

const decimalPattern = /^\d+(?:\.\d{1,2})?$/;

function hundredths(value: string): number | null {
  if (!decimalPattern.test(value.trim())) return null;
  const [whole = '0', fraction = ''] = value.trim().split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
}

export interface ScoringValidation {
  errors: Partial<Record<keyof ScoringInput | 'weights', string>>;
  weightTotal: number;
  valid: boolean;
}

export function validateScoringInput(input: ScoringInput): ScoringValidation {
  const errors: ScoringValidation['errors'] = {};
  const bars = ['footfallBar', 'revenueBar', 'sizeBar'] as const;
  const weights = ['footfallWeight', 'revenueWeight', 'sizeWeight'] as const;
  for (const field of bars) {
    if (hundredths(input[field]) === null)
      errors[field] = 'Enter a nonnegative number with up to two decimals.';
  }
  const parsedWeights = weights.map((field) => {
    const value = hundredths(input[field]);
    if (value === null || value > 10_000) errors[field] = 'Enter a percentage from 0 to 100.';
    return value ?? 0;
  });
  const totalHundredths = parsedWeights.reduce((total, value) => total + value, 0);
  if (totalHundredths !== 10_000) errors.weights = 'The three weights must total exactly 100%.';
  const large = hundredths(input.largeThreshold);
  const medium = hundredths(input.mediumThreshold);
  if (large === null || large > 10_000) errors.largeThreshold = 'Enter a threshold from 0 to 100.';
  if (medium === null || medium > 10_000)
    errors.mediumThreshold = 'Enter a threshold from 0 to 100.';
  if (large !== null && medium !== null && large <= medium) {
    errors.largeThreshold = 'Large threshold must be greater than Medium threshold.';
  }
  return { errors, weightTotal: totalHundredths / 100, valid: Object.keys(errors).length === 0 };
}
