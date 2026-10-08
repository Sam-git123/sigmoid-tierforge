export interface ScoringConfiguration {
  footfallBar: string;
  revenueBar: string;
  sizeBar: string;
  footfallWeight: string;
  revenueWeight: string;
  sizeWeight: string;
  largeThreshold: string;
  mediumThreshold: string;
}

export interface ScoringMetrics {
  estimatedMonthlyFootfall: string | number;
  estimatedMonthlyRevenue: string | number;
  storeSizeSqft: string | number;
}

export type StoreTier = 'Large' | 'Medium' | 'Small';

export interface TierCounts {
  large: number;
  medium: number;
  small: number;
}

export interface ScoringSummary {
  jobId: string;
  revision: number;
  configuration: ScoringConfiguration;
  storesScored: number;
  tierCounts: TierCounts;
}

function hundredths(value: string | number): bigint {
  const text = typeof value === 'number' ? value.toFixed(2) : value;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

export function calculateStoreScore(
  metrics: ScoringMetrics,
  configuration: ScoringConfiguration,
): { score: number; tier: StoreTier } {
  let score = 0n;
  if (hundredths(metrics.estimatedMonthlyFootfall) >= hundredths(configuration.footfallBar)) {
    score += hundredths(configuration.footfallWeight);
  }
  if (hundredths(metrics.estimatedMonthlyRevenue) >= hundredths(configuration.revenueBar)) {
    score += hundredths(configuration.revenueWeight);
  }
  if (hundredths(metrics.storeSizeSqft) >= hundredths(configuration.sizeBar)) {
    score += hundredths(configuration.sizeWeight);
  }
  const tier: StoreTier =
    score >= hundredths(configuration.largeThreshold)
      ? 'Large'
      : score >= hundredths(configuration.mediumThreshold)
        ? 'Medium'
        : 'Small';
  return { score: Number(score) / 100, tier };
}
