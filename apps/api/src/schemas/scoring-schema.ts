import { z } from 'zod';

function asDecimalText(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
  if (typeof value === 'string') return value.trim();
  return value;
}

function decimalHundredths(value: string): number {
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function normalizeDecimal(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  return `${normalizedWhole}.${fraction.padEnd(2, '0')}`;
}

const decimalText = z.preprocess(
  asDecimalText,
  z.string().regex(/^\d+(?:\.\d{1,2})?$/, 'Must be a nonnegative decimal with at most 2 places.'),
);

const bar = decimalText
  .refine((value) => value.split('.')[0]!.replace(/^0+/, '').length <= 16, {
    message: 'Must have at most 16 integer digits.',
  })
  .transform(normalizeDecimal);

const percentage = decimalText
  .refine((value) => decimalHundredths(value) <= 10_000, {
    message: 'Must be between 0 and 100.',
  })
  .transform(normalizeDecimal);

export const scoringConfigurationSchema = z
  .object({
    footfallBar: bar,
    revenueBar: bar,
    sizeBar: bar,
    footfallWeight: percentage,
    revenueWeight: percentage,
    sizeWeight: percentage,
    largeThreshold: percentage,
    mediumThreshold: percentage,
  })
  .strict()
  .superRefine((configuration, context) => {
    const weightTotal =
      decimalHundredths(configuration.footfallWeight) +
      decimalHundredths(configuration.revenueWeight) +
      decimalHundredths(configuration.sizeWeight);
    if (weightTotal !== 10_000) {
      context.addIssue({
        code: 'custom',
        path: ['footfallWeight'],
        message: 'Footfall, revenue, and size weights must total exactly 100.00%.',
      });
    }
    if (
      decimalHundredths(configuration.largeThreshold) <=
      decimalHundredths(configuration.mediumThreshold)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['largeThreshold'],
        message: 'Large threshold must be greater than Medium threshold.',
      });
    }
  });

export type ScoringConfigurationInput = z.input<typeof scoringConfigurationSchema>;
