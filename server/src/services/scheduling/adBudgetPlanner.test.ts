import { describe, expect, it } from 'vitest';
import {
  gridPointAtOrAfter,
  gridPointAtOrBefore,
  planAds,
  spreadIndexes,
  type AdPlanInput,
} from './adBudgetPlanner.ts';

const Min = 60_000;
const Sec = 1000;

// The configuration used by the design proposal's examples: 15 to 20% ads,
// mid breaks of 2:00 to 2:30, a post break of 1 to 5 minutes.
function base(overrides: Partial<AdPlanInput> = {}): AdPlanInput {
  return {
    contentMs: 75 * Min,
    startPhaseMs: 0,
    padMs: 30 * Min,
    ratioMin: 0.15,
    ratioMax: 0.2,
    latestEndMs: 10 * 60 * Min,
    mid: { minMs: 2 * Min, maxMs: 2.5 * Min },
    midPositions: 8,
    singles: { post: { minMs: 1 * Min, maxMs: 5 * Min } },
    gridMs: 5 * Sec,
    ...overrides,
  };
}

describe('grid helpers', () => {
  it('rounds up to the next grid point', () => {
    expect(gridPointAtOrAfter(70 * Min, 0, 30 * Min)).toBe(90 * Min);
    expect(gridPointAtOrAfter(60 * Min, 0, 30 * Min)).toBe(60 * Min);
  });

  it('accounts for a program that starts off the grid', () => {
    // Starts 10 minutes past a grid point: grid points are at 20, 50, ...
    expect(gridPointAtOrAfter(25 * Min, 10 * Min, 30 * Min)).toBe(50 * Min);
    expect(gridPointAtOrBefore(55 * Min, 10 * Min, 30 * Min)).toBe(50 * Min);
  });

  it('treats a program within the tolerance as already on the grid', () => {
    expect(gridPointAtOrAfter(60 * Min + 4 * Sec, 0, 30 * Min, 5 * Sec)).toBe(
      60 * Min,
    );
  });

  it('spreads indexes evenly', () => {
    expect(spreadIndexes(0, 5)).toEqual([]);
    expect(spreadIndexes(1, 5)).toEqual([2]);
    expect(spreadIndexes(2, 4)).toEqual([1, 3]);
    expect(spreadIndexes(9, 3)).toEqual([0, 1, 2]);
  });
});

describe('planAds: the design proposal examples', () => {
  const cases: {
    name: string;
    content: number;
    pad: number;
    end: number;
    maxAd: number;
  }[] = [
    { name: '75 min on 15 min', content: 75, pad: 15, end: 90, maxAd: 15 },
    { name: '75 min on 30 min', content: 75, pad: 30, end: 90, maxAd: 15 },
    { name: '61 min on 30 min', content: 61, pad: 30, end: 90, maxAd: 12.2 },
    { name: '61 min on 15 min', content: 61, pad: 15, end: 75, maxAd: 12.2 },
    { name: '93 min on 30 min', content: 93, pad: 30, end: 120, maxAd: 18.6 },
  ];

  for (const c of cases) {
    it(`${c.name}: block ends at ${c.end} min`, () => {
      const plan = planAds(
        base({ contentMs: c.content * Min, padMs: c.pad * Min }),
      );
      expect(plan.blockMs).toBe(c.end * Min);
      // Ads never exceed the maximum ratio, and come within a few grid steps
      // of it.
      expect(plan.adMs).toBeLessThanOrEqual(c.maxAd * Min);
      expect(plan.adMs).toBeGreaterThan(c.maxAd * Min - 30 * Sec);
      expect(plan.fallbackMs).toBe(plan.blockMs - c.content * Min - plan.adMs);
    });
  }

  it('leaves no fallback time when the room equals the ad budget', () => {
    const plan = planAds(base({ contentMs: 75 * Min, padMs: 15 * Min }));
    expect(plan.fallbackMs).toBeLessThan(30 * Sec);
  });

  it('gives a program with little room as many ads as fit', () => {
    // 90 min of content on a 30 min grid has no room for 15% ads before the
    // next grid point without going to 120. Capping the end at 90 leaves none.
    const plan = planAds(
      base({ contentMs: 90 * Min, latestEndMs: 90 * Min, padMs: 30 * Min }),
    );
    expect(plan.blockMs).toBe(90 * Min);
    expect(plan.adMs).toBe(0);
    expect(plan.fallbackMs).toBe(0);
  });

  it('splits the proposal 3-hour slot between a 75 and an 88 minute program', () => {
    // The first program may end at 1:30 only if the second still fits: it
    // needs 90 min (88 rounded up), so the first has until 90 min.
    const first = planAds(
      base({ contentMs: 75 * Min, latestEndMs: 180 * Min - 90 * Min }),
    );
    expect(first.blockMs).toBe(90 * Min);
    expect(first.adMs).toBeGreaterThan(14 * Min);

    const second = planAds(
      base({ contentMs: 88 * Min, latestEndMs: 90 * Min }),
    );
    expect(second.blockMs).toBe(90 * Min);
    expect(second.adMs).toBeLessThanOrEqual(2 * Min);
  });
});

describe('planAds: allocation', () => {
  it('keeps every mid break inside its range and on the grid', () => {
    const plan = planAds(base({ contentMs: 75 * Min, padMs: 30 * Min }));
    expect(plan.mid.length).toBeGreaterThan(0);
    for (const m of plan.mid) {
      expect(m).toBeGreaterThanOrEqual(2 * Min);
      expect(m).toBeLessThanOrEqual(2.5 * Min);
      expect(m % (5 * Sec)).toBe(0);
    }
  });

  it('keeps the post break inside its range', () => {
    const plan = planAds(base());
    expect(plan.post).toBeDefined();
    expect(plan.post!).toBeGreaterThanOrEqual(1 * Min);
    expect(plan.post!).toBeLessThanOrEqual(5 * Min);
  });

  it('never plans more mid breaks than the rule offers positions', () => {
    const plan = planAds(base({ midPositions: 2 }));
    expect(plan.mid.length).toBeLessThanOrEqual(2);
    expect(plan.midPositionIndexes.length).toBe(plan.mid.length);
  });

  it('uses only post time when the program has no mid positions', () => {
    const plan = planAds(base({ midPositions: 0 }));
    expect(plan.mid).toEqual([]);
    // post is capped at its maximum, the rest of the budget is fallback
    expect(plan.post).toBe(5 * Min);
    expect(plan.fallbackMs).toBeGreaterThan(0);
  });

  it('drops head, then pre, when the budget is too small for every minimum', () => {
    const plan = planAds(
      base({
        contentMs: 20 * Min,
        padMs: 5 * Min,
        midPositions: 0,
        mid: undefined,
        singles: {
          head: { minMs: 2 * Min, maxMs: 3 * Min },
          pre: { minMs: 2 * Min, maxMs: 3 * Min },
          post: { minMs: 1 * Min, maxMs: 2 * Min },
        },
      }),
    );
    // 20% of 20 min = 4 min: head and pre cannot both fit with post.
    expect(plan.head).toBeUndefined();
    expect(plan.post).toBeDefined();
  });

  it('plans nothing when no position has a range', () => {
    const plan = planAds(base({ mid: undefined, singles: {} }));
    expect(plan.adMs).toBe(0);
    expect(plan.fallbackMs).toBe(plan.blockMs - 75 * Min);
  });

  it('plans nothing for a program too short for one grid step of ads', () => {
    const plan = planAds(base({ contentMs: 20 * Sec, padMs: 1 * Min }));
    expect(plan.adMs).toBe(0);
  });
});

describe('planAds: invariants over many inputs', () => {
  // A small deterministic generator so failures reproduce.
  let seed = 123456789;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);

  it('holds for 5000 random programs', () => {
    for (let i = 0; i < 5000; i++) {
      const padMs = [5, 10, 15, 30, 60][Math.floor(rand() * 5)]! * Min;
      const contentMs = Math.round(between(8 * Min, 200 * Min));
      const startPhaseMs = rand() < 0.5 ? 0 : Math.round(between(0, padMs));
      const ratioMin = between(0, 0.2);
      const ratioMax = ratioMin + between(0, 0.15);
      const gridMs = [5, 10, 15, 20, 30][Math.floor(rand() * 5)]! * Sec;
      const midMin = Math.round(between(30, 150)) * Sec;
      const input: AdPlanInput = {
        contentMs,
        startPhaseMs,
        padMs,
        ratioMin,
        ratioMax,
        latestEndMs: contentMs + Math.round(between(0, 90 * Min)),
        mid: {
          minMs: midMin,
          maxMs: midMin + Math.round(between(0, 90)) * Sec,
        },
        midPositions: Math.floor(between(0, 10)),
        singles:
          rand() < 0.5
            ? {
                post: {
                  minMs: 30 * Sec,
                  maxMs: Math.round(between(31, 300)) * Sec,
                },
              }
            : {},
        gridMs,
      };
      const plan = planAds(input);
      const ctx = JSON.stringify({ input, plan });

      // The block is long enough for the content.
      expect(plan.blockMs, ctx).toBeGreaterThanOrEqual(contentMs);
      // It ends on the pad grid.
      expect((startPhaseMs + plan.blockMs) % padMs, ctx).toBe(0);
      // Ads and fallback add up to the room.
      expect(plan.adMs + plan.fallbackMs, ctx).toBe(plan.blockMs - contentMs);
      expect(plan.fallbackMs, ctx).toBeGreaterThanOrEqual(0);
      // Ads respect the maximum ratio.
      expect(plan.adMs, ctx).toBeLessThanOrEqual(
        Math.floor(contentMs * ratioMax),
      );
      // The block does not outgrow the limit unless the content itself does.
      const contentEnd = gridPointAtOrAfter(contentMs, startPhaseMs, padMs);
      expect(plan.blockMs, ctx).toBeLessThanOrEqual(
        Math.max(input.latestEndMs, contentEnd),
      );
      // Every piece is within its range and on the break length grid.
      let sum = plan.post ?? 0;
      for (const m of plan.mid) {
        expect(m, ctx).toBeGreaterThanOrEqual(input.mid!.minMs);
        expect(m, ctx).toBeLessThanOrEqual(input.mid!.maxMs);
        // Only a real range is on the step; an exact length is taken as is.
        if (input.mid!.minMs !== input.mid!.maxMs) {
          expect(m % gridMs, ctx).toBe(0);
        }
        sum += m;
      }
      expect(sum, ctx).toBe(plan.adMs);
      expect(plan.mid.length, ctx).toBeLessThanOrEqual(input.midPositions);
    }
  });
});

describe('planAds: bumpers and exact lengths', () => {
  it('takes the bumpers out of the room before planning the ads', () => {
    // 75 min on a 15 min grid, with 30 s of bumpers: room is 15:00 - 0:30.
    const plan = planAds(
      base({ contentMs: 75 * Min, padMs: 15 * Min, fixedMs: 30 * Sec }),
    );
    expect(plan.blockMs).toBe(90 * Min);
    expect(plan.adMs + plan.fallbackMs).toBe(15 * Min - 30 * Sec);
  });

  it('moves the block to the next grid point when the bumpers tip it over', () => {
    // 59 min 50 s of content fits an hour on its own; 20 s of bumpers do not.
    const without = planAds(
      base({
        contentMs: 59 * Min + 50 * Sec,
        padMs: 15 * Min,
        ratioMin: 0,
        singles: {},
        mid: undefined,
      }),
    );
    const withBumpers = planAds(
      base({
        contentMs: 59 * Min + 50 * Sec,
        padMs: 15 * Min,
        ratioMin: 0,
        singles: {},
        mid: undefined,
        fixedMs: 20 * Sec,
      }),
    );
    expect(without.blockMs).toBe(60 * Min);
    expect(withBumpers.blockMs).toBe(75 * Min);
  });

  it('does not count bumpers towards the ad share', () => {
    const plan = planAds(
      base({ contentMs: 75 * Min, padMs: 30 * Min, fixedMs: 2 * Min }),
    );
    expect(plan.adMs).toBeLessThanOrEqual(0.2 * 75 * Min);
  });

  it('treats min equal to max as an exact length, off the step', () => {
    // 2:10 is not a multiple of 15 s. A range of exactly 2:10 is still valid.
    const plan = planAds(
      base({
        contentMs: 75 * Min,
        padMs: 30 * Min,
        gridMs: 15 * Sec,
        mid: { minMs: 130 * Sec, maxMs: 130 * Sec },
        singles: {},
      }),
    );
    expect(plan.mid.length).toBeGreaterThan(0);
    for (const m of plan.mid) expect(m).toBe(130 * Sec);
  });

  it('plans an exact post length', () => {
    const plan = planAds(
      base({
        contentMs: 75 * Min,
        padMs: 30 * Min,
        singles: { post: { minMs: 2 * Min, maxMs: 2 * Min } },
      }),
    );
    expect(plan.post).toBe(2 * Min);
  });
});

describe('planAds: using the offered break positions', () => {
  it('uses every offered position when the budget holds their minimum lengths', () => {
    // 50 min of content on a 15 min grid: a 60 min block, 10:00 of ads. Four
    // positions at 2:00 each plus a 1:00 post break fit.
    const plan = planAds(
      base({
        contentMs: 50 * Min,
        padMs: 15 * Min,
        midPositions: 4,
        mid: { minMs: 2 * Min, maxMs: 3 * Min },
      }),
    );
    expect(plan.mid.length).toBe(4);
    expect(plan.midPositionIndexes).toEqual([0, 1, 2, 3]);
  });

  it('stretches the breaks towards their maximum with what is left', () => {
    const plan = planAds(
      base({
        contentMs: 50 * Min,
        padMs: 15 * Min,
        midPositions: 2,
        mid: { minMs: 2 * Min, maxMs: 3 * Min },
        singles: {},
      }),
    );
    // Two positions, 10:00 of budget: both breaks reach their maximum.
    expect(plan.mid).toEqual([3 * Min, 3 * Min]);
    expect(plan.fallbackMs).toBeGreaterThan(0);
  });

  it('drops positions only when the budget runs out', () => {
    // 22 min of content: the ad budget is 4:24, which holds one 2:00 break next
    // to a 1:00 post break, not two.
    const plan = planAds(
      base({
        contentMs: 22 * Min,
        padMs: 15 * Min,
        midPositions: 2,
        mid: { minMs: 2 * Min, maxMs: 3 * Min },
      }),
    );
    expect(plan.mid.length).toBe(1);
  });
});

describe('planAds: positions around the program come first', () => {
  it('grows post to its maximum before the mid breaks stretch', () => {
    // 100 minutes of content, 25% ads: 25 minutes. Post 1 to 3 minutes, mid
    // breaks of 2 to 3 minutes at 8 positions.
    const plan = planAds(
      base({
        contentMs: 100 * Min,
        ratioMin: 0.25,
        ratioMax: 0.25,
        singles: { post: { minMs: 1 * Min, maxMs: 3 * Min } },
        mid: { minMs: 2 * Min, maxMs: 3 * Min },
        gridMs: 15 * Sec,
      }),
    );
    expect(plan.post).toBe(3 * Min);
    expect(plan.adMs).toBeLessThanOrEqual(25 * Min);
    for (const m of plan.mid) {
      expect(m).toBeGreaterThanOrEqual(2 * Min);
      expect(m).toBeLessThanOrEqual(3 * Min);
    }
  });
});

describe('planAds: the extra time rises like a water level', () => {
  const cfg = (extra: Partial<AdPlanInput> = {}) =>
    base({
      contentMs: 40 * Min,
      padMs: 15 * Min,
      ratioMin: 0.05,
      ratioMax: 1,
      gridMs: 15 * Sec,
      mid: { minMs: 2 * Min, maxMs: 3 * Min },
      midPositions: 2,
      singles: {
        post: { minMs: 0, maxMs: 5 * Min },
        tail: { minMs: 0, maxMs: 25 * Min },
      },
      ...extra,
    });

  it('lets post and tail catch up with the mid breaks first', () => {
    // 40 min of content in a 45 min block: 5 min of room. Two mid breaks at
    // their 2 min minimum take 4 min; post and tail share the last minute.
    const plan = planAds(cfg());
    expect(plan.mid).toEqual([2 * Min, 2 * Min]);
    expect((plan.post ?? 0) + (plan.tail ?? 0)).toBe(1 * Min);
  });

  it('raises every position together once they are level', () => {
    // 40 min of content in a 50 min block (5 min grid): 10 min of room, and
    // nothing reaches a maximum. Both mid breaks, the post and the tail end up
    // within a step of each other.
    const plan = planAds(
      cfg({ padMs: 5 * Min, latestEndMs: 50 * Min, ratioMin: 0.2 }),
    );
    const [m1, m2] = plan.mid;
    expect(Math.abs(m1! - m2!)).toBeLessThanOrEqual(15 * Sec);
    const levels = [m1!, m2!, plan.post ?? 0, plan.tail ?? 0];
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(
      15 * Sec,
    );
    expect(plan.adMs).toBe(10 * Min);
  });

  it('lets some mid breaks run a step longer when nothing else can rise', () => {
    // 10 min of room. Post and tail are capped at 1 min each, so the three mid
    // breaks take the other 8 min: two whole rounds of steps and two steps
    // over. The two extra steps go to single breaks.
    const plan = planAds(
      cfg({
        padMs: 5 * Min,
        latestEndMs: 50 * Min,
        ratioMin: 0.2,
        singles: {
          post: { minMs: 0, maxMs: 1 * Min },
          tail: { minMs: 0, maxMs: 1 * Min },
        },
        mid: { minMs: 2 * Min, maxMs: 4 * Min },
        midPositions: 3,
        gridMs: 15 * Sec,
      }),
    );
    expect(plan.mid.length).toBe(3);
    const spread = Math.max(...plan.mid) - Math.min(...plan.mid);
    expect(spread).toBe(15 * Sec);
    // The budget is spent: nothing is left for the dead air.
    expect(plan.fallbackMs).toBeLessThan(15 * Sec);
  });

  it('allows a position with a minimum of 0 to stay empty', () => {
    const plan = planAds(cfg({ ratioMin: 0.02 }));
    expect(plan.post ?? 0).toBeGreaterThanOrEqual(0);
    expect(plan.adMs).toBeGreaterThanOrEqual(0);
  });
});
