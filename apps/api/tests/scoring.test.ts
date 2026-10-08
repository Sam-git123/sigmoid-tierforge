import { describe, expect, it } from 'vitest';
import { calculateStoreScore, type ScoringConfiguration } from '../src/domain/scoring.js';
import { scoringConfigurationSchema } from '../src/schemas/scoring-schema.js';

const configuration: ScoringConfiguration = {
  footfallBar: '15000.00',
  revenueBar: '150000.00',
  sizeBar: '8000.00',
  footfallWeight: '50.00',
  revenueWeight: '30.00',
  sizeWeight: '20.00',
  largeThreshold: '70.00',
  mediumThreshold: '40.00',
};

describe('exact scoring formula', () => {
  it.each([
    [40000, 400000, 18000, 100, 'Large'],
    [20000, 100000, 5000, 50, 'Medium'],
    [2000, 20000, 9000, 20, 'Small'],
  ] as const)(
    'matches the Sigmoid example for footfall %s, revenue %s, size %s',
    (footfall, revenue, size, score, tier) => {
      expect(
        calculateStoreScore(
          {
            estimatedMonthlyFootfall: footfall,
            estimatedMonthlyRevenue: revenue,
            storeSizeSqft: size,
          },
          configuration,
        ),
      ).toEqual({ score, tier });
    },
  );

  it('uses inclusive metric bars and inclusive Large and Medium boundaries', () => {
    expect(
      calculateStoreScore(
        {
          estimatedMonthlyFootfall: 15000,
          estimatedMonthlyRevenue: 150000,
          storeSizeSqft: 0,
        },
        configuration,
      ),
    ).toEqual({ score: 80, tier: 'Large' });
    expect(
      calculateStoreScore(
        {
          estimatedMonthlyFootfall: 15000,
          estimatedMonthlyRevenue: 0,
          storeSizeSqft: 0,
        },
        { ...configuration, largeThreshold: '90.00', mediumThreshold: '50.00' },
      ),
    ).toEqual({ score: 50, tier: 'Medium' });
    expect(
      calculateStoreScore(
        {
          estimatedMonthlyFootfall: 15000,
          estimatedMonthlyRevenue: 0,
          storeSizeSqft: 8000,
        },
        configuration,
      ),
    ).toEqual({ score: 70, tier: 'Large' });
  });

  it('returns zero/Small when all bars fail and 100/Large when all pass', () => {
    expect(
      calculateStoreScore(
        { estimatedMonthlyFootfall: 0, estimatedMonthlyRevenue: 0, storeSizeSqft: 0 },
        configuration,
      ),
    ).toEqual({ score: 0, tier: 'Small' });
    expect(
      calculateStoreScore(
        {
          estimatedMonthlyFootfall: 15000,
          estimatedMonthlyRevenue: 150000,
          storeSizeSqft: 8000,
        },
        configuration,
      ),
    ).toEqual({ score: 100, tier: 'Large' });
  });

  it('allows a zero-weight metric without adding to the score', () => {
    expect(
      calculateStoreScore(
        { estimatedMonthlyFootfall: 0, estimatedMonthlyRevenue: 1, storeSizeSqft: 0 },
        {
          ...configuration,
          footfallBar: '0.00',
          revenueBar: '1.00',
          footfallWeight: '0.00',
          revenueWeight: '80.00',
        },
      ),
    ).toEqual({ score: 80, tier: 'Large' });
  });
});

describe('scoring configuration validation', () => {
  it('normalizes numbers to exact two-decimal strings', () => {
    expect(
      scoringConfigurationSchema.parse({
        footfallBar: 15000,
        revenueBar: 150000,
        sizeBar: 8000,
        footfallWeight: 50,
        revenueWeight: 30,
        sizeWeight: 20,
        largeThreshold: 70,
        mediumThreshold: 40,
      }),
    ).toEqual(configuration);
  });

  it('rejects an inexact weight total and excess decimal precision', () => {
    const invalidTotal = scoringConfigurationSchema.safeParse({
      ...configuration,
      footfallWeight: 49.99,
    });
    expect(invalidTotal.success).toBe(false);
    expect(invalidTotal.error?.issues[0]?.message).toContain('total exactly 100.00%');
    expect(
      scoringConfigurationSchema.safeParse({ ...configuration, revenueWeight: '30.001' }).success,
    ).toBe(false);
  });

  it('rejects negative bars, out-of-range percentages, and reversed thresholds', () => {
    expect(scoringConfigurationSchema.safeParse({ ...configuration, sizeBar: -1 }).success).toBe(
      false,
    );
    expect(
      scoringConfigurationSchema.safeParse({ ...configuration, sizeWeight: 101 }).success,
    ).toBe(false);
    expect(
      scoringConfigurationSchema.safeParse({
        ...configuration,
        largeThreshold: 40,
        mediumThreshold: 40,
      }).success,
    ).toBe(false);
  });
});
