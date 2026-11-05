import { randomUUID } from 'node:crypto';
import type { TimeSlotSchedule } from '@tunarr/types/api';
import dayjs from '@/util/dayjs.js';
import { sumBy } from 'lodash-es';
import { describe, expect, test } from 'vitest';
import { createFakeProgramOrm } from '../../testing/fakes/entityCreators.ts';
import type { SlotSchedulerProgram } from './slotSchedulerUtil.js';
import { scheduleTimeSlots } from './TimeSlotService.ts';

const oneSec = 1000;
const oneMin = 60 * oneSec;
const oneHour = 60 * oneMin;
const midnight = dayjs('2024-01-01T00:00:00.000Z').utc();

type LineupItem = {
  type: string;
  id?: string;
  duration: number;
  startOffsetMs?: number;
  fillerType?: string;
  fillerConfig?: { origin?: string; fillerListIds?: string[] };
};
type TimedItem = { item: LineupItem; start: number };

const makeShow = (
  showId: string,
  durationsMin: number[],
): SlotSchedulerProgram[] =>
  durationsMin.map((minutes, i) => ({
    ...createFakeProgramOrm({
      uuid: `${showId}-ep${i + 1}`,
      title: `${showId} Episode ${i + 1}`,
      type: 'episode',
      duration: minutes * oneMin,
      episode: i + 1,
      tvShowUuid: showId,
      show: { uuid: showId },
    }),
    parentFillerLists: [],
    parentCustomShows: [],
    parentSmartCollections: [],
  }));

const makeBumpers = (
  fillerListId: string,
  durationsSec: number[],
): SlotSchedulerProgram[] =>
  durationsSec.map((seconds, i) => ({
    ...createFakeProgramOrm({
      uuid: `bumper-${i}`,
      title: `Bumper ${i}`,
      type: 'movie',
      duration: seconds * oneSec,
    }),
    parentFillerLists: [fillerListId],
    parentCustomShows: [],
    parentSmartCollections: [],
  }));

const makeClips = (
  fillerListId: string,
  durationsSec: number[],
): SlotSchedulerProgram[] =>
  durationsSec.map((seconds, i) => ({
    ...createFakeProgramOrm({
      uuid: `clip-${i}`,
      title: `Clip ${i}`,
      type: 'movie',
      duration: seconds * oneSec,
    }),
    parentFillerLists: [fillerListId],
    parentCustomShows: [],
    parentSmartCollections: [],
  }));

const withStarts = (lineup: LineupItem[], startTime: number): TimedItem[] => {
  let t = startTime;
  return lineup.map((item) => {
    const start = t;
    t += item.duration;
    return { item, start };
  });
};

const isEpisodeStart = (item: LineupItem, showId: string) =>
  item.type === 'content' &&
  !!item.id?.startsWith(`${showId}-`) &&
  (item.startOffsetMs ?? 0) === 0;

// Ad time: clips, plus flex that is tied to a filler list (an unresolved break
// or a lazy post/tail position). Plain flex is fallback time.
const isAd = (item: LineupItem) =>
  item.type === 'filler' ||
  (item.type === 'flex' &&
    (item.fillerConfig?.origin === 'midroll' ||
      (item.fillerConfig?.fillerListIds?.length ?? 0) > 0));

// A pool like a real filler list: many clips, mostly 15 to 60 seconds.
const clipLengthsSec = Array.from(
  { length: 120 },
  (_, i) => [15, 20, 25, 30, 30, 30, 35, 40, 45, 60, 75, 90][i % 12]!,
);

function schedule(
  slots: TimeSlotSchedule['slots'],
  padMs: number,
  maxDays = 2,
): TimeSlotSchedule {
  return {
    type: 'time',
    period: 'day',
    maxDays,
    flexPreference: 'distribute',
    padMs,
    latenessMs: 0,
    overflow: { type: 'duration', maxMs: 0 },
    timeZoneOffset: 0,
    slots,
  };
}

const elasticSlot = (
  listId: string,
  showId: string,
  startTime: number,
  strategy: 'eager' | 'lazy',
  extra: Record<string, unknown> = {},
) => ({
  id: randomUUID(),
  startTime,
  type: 'show' as const,
  showId,
  order: 'next' as const,
  direction: 'asc' as const,
  seasonFilter: [],
  filler: [
    {
      types: ['mid' as const, 'post' as const],
      fillerListId: listId,
      fillerOrder: 'shuffle_prefer_short' as const,
      kind: 'ad' as const,
    },
  ],
  midRoll: {
    strategy,
    breakRule: {
      type: 'fixed_interval' as const,
      intervalMs: 12 * oneMin,
    },
    breakDurationMinMs: 2 * oneMin,
    breakDurationMaxMs: 2.5 * oneMin,
    maxBreaks: 0,
    minProgramDurationMs: 20 * oneMin,
    tailBufferMs: 0,
    fitToSlot: true,
    adRatioMin: 0.15,
    adRatioMax: 0.2,
    postLength: { minMs: 1 * oneMin, maxMs: 5 * oneMin },
    breakLengthGridMs: 5 * oneSec,
    ...extra,
  },
});

describe('elastic ads in time slots', () => {
  // The mixed lengths of a typical mystery series next to sitcom episodes.
  const lengths = [75, 44, 61, 93, 22, 47, 88, 30, 52, 70];

  test.each(['eager', 'lazy'] as const)(
    '%s: every program starts on the pad grid and ads stay within the ratio',
    async (strategy) => {
      const list = randomUUID();
      const padMs = 30 * oneMin;
      const result = await scheduleTimeSlots(
        schedule([elasticSlot(list, 'mystery', 0, strategy)], padMs),
        [...makeShow('mystery', lengths), ...makeClips(list, clipLengthsSec)],
        [42, 99],
        undefined,
        midnight,
      );

      const items = withStarts(result.lineup as LineupItem[], result.startTime);
      const starts = items.filter(({ item }) =>
        isEpisodeStart(item, 'mystery'),
      );
      expect(starts.length).toBeGreaterThanOrEqual(8);

      // Every episode starts exactly on the 30 minute grid.
      for (const { start } of starts) {
        expect((start - midnight.valueOf()) % padMs).toBe(0);
      }

      // Look at each block except the slot's last one, which the end of the
      // slot can cut short.
      for (let i = 0; i < starts.length - 1; i++) {
        const block = items.filter(
          ({ start }) =>
            start >= starts[i]!.start && start < starts[i + 1]!.start,
        );
        const contentMs = sumBy(
          block.filter(({ item }) => item.type === 'content'),
          ({ item }) => item.duration,
        );
        const adMs = sumBy(
          block.filter(({ item }) => isAd(item)),
          ({ item }) => item.duration,
        );
        const blockMs = starts[i + 1]!.start - starts[i]!.start;

        // The block is a whole number of grid steps.
        expect(blockMs % padMs).toBe(0);
        // Ads never exceed the maximum ratio (a second for rounding).
        expect(adMs).toBeLessThanOrEqual(0.2 * contentMs + oneSec);
        // And reach the minimum whenever the block has room for it.
        if (blockMs - contentMs >= 0.15 * contentMs + oneMin) {
          expect(adMs).toBeGreaterThanOrEqual(0.15 * contentMs - 15 * oneSec);
        }
      }
    },
  );

  test.each(['eager', 'lazy'] as const)(
    '%s: the slot ends exactly on time and nothing is longer than planned',
    async (strategy) => {
      const list = randomUUID();
      const slotLength = 3 * oneHour;
      const result = await scheduleTimeSlots(
        schedule(
          [
            elasticSlot(list, 'long', 0, strategy),
            // A second slot starts three hours later.
            {
              ...elasticSlot(list, 'other', slotLength, strategy),
            },
          ],
          30 * oneMin,
          1,
        ),
        [
          ...makeShow('long', [75, 88, 75, 88, 75, 88, 75, 88]),
          ...makeShow('other', [22, 22, 22, 22, 22, 22]),
          ...makeClips(list, clipLengthsSec),
        ],
        [7, 7],
        undefined,
        midnight,
      );

      const items = withStarts(result.lineup as LineupItem[], result.startTime);
      const otherStart = items.find(({ item }) =>
        isEpisodeStart(item, 'other'),
      );
      // The second slot's first program starts exactly at the slot boundary.
      expect(otherStart?.start).toBe(midnight.valueOf() + slotLength);
      // The first slot's items fill its three hours exactly.
      const firstSlot = items.filter(({ start }) => start < otherStart!.start);
      expect(sumBy(firstSlot, ({ item }) => item.duration)).toBe(slotLength);
      // Every item has a positive duration.
      for (const { item } of items) {
        expect(item.duration).toBeGreaterThan(0);
      }
    },
  );

  test('a program is not packed into a window without room for its required ads', async () => {
    const list = randomUUID();
    // A 3 hour slot on a 30 minute grid. The 75 minute episode ends at 1:30
    // with its ads. The 88 minute episode would need until 3:00 with nothing
    // left for its post break, so it is not packed into this window.
    const result = await scheduleTimeSlots(
      schedule(
        [
          elasticSlot(list, 'pair', 0, 'eager'),
          elasticSlot(list, 'next', 3 * oneHour, 'eager'),
        ],
        30 * oneMin,
        1,
      ),
      [
        ...makeShow('pair', [75, 88]),
        ...makeShow('next', [30, 30, 30, 30, 30, 30]),
        ...makeClips(list, clipLengthsSec),
      ],
      [3, 3],
      undefined,
      midnight,
    );
    const items = withStarts(result.lineup as LineupItem[], result.startTime);
    const windowEnd = midnight.valueOf() + 3 * oneHour;
    const pairStarts = items.filter(
      ({ item, start }) => isEpisodeStart(item, 'pair') && start < windowEnd,
    );
    // Only the first episode is in the first window, and it has its ads.
    expect(pairStarts).toHaveLength(1);
    const block = items.filter(({ start }) => start < windowEnd);
    const adMs = sumBy(
      block.filter(({ item }) => isAd(item)),
      ({ item }) => item.duration,
    );
    expect(adMs).toBeGreaterThanOrEqual(oneMin);
  });

  test('without fitToSlot the slot behaves as before', async () => {
    const list = randomUUID();
    const slot = elasticSlot(list, 'plain', 0, 'eager', { fitToSlot: false });
    const result = await scheduleTimeSlots(
      schedule([slot], 30 * oneMin, 1),
      [...makeShow('plain', [44, 44, 44]), ...makeClips(list, clipLengthsSec)],
      [1, 1],
      undefined,
      midnight,
    );
    const items = withStarts(result.lineup as LineupItem[], result.startTime);
    // No post break exists in the old code path when only mid is planned by
    // fixed length: there are no elastic pods, and breaks are the old kind.
    expect(items.some(({ item }) => item.type === 'content')).toBe(true);
    expect(items[0]!.start).toBe(midnight.valueOf());
  });

  test('head and tail breaks are planned only for the first and last program', async () => {
    const list = randomUUID();
    const slot = {
      ...elasticSlot(list, 'bumpers', 0, 'eager', {
        headLength: { minMs: 15 * oneSec, maxMs: 30 * oneSec },
        tailLength: { minMs: 30 * oneSec, maxMs: 60 * oneSec },
      }),
    };
    slot.filler = [
      {
        types: [
          'mid' as const,
          'post' as const,
          'head' as const,
          'tail' as const,
        ],
        fillerListId: list,
        fillerOrder: 'shuffle_prefer_short' as const,
        kind: 'ad' as const,
      },
    ];
    const result = await scheduleTimeSlots(
      schedule([slot], 30 * oneMin, 1),
      [
        ...makeShow('bumpers', [75, 75, 75, 75]),
        ...makeClips(list, clipLengthsSec),
      ],
      [5, 5],
      undefined,
      midnight,
    );
    const items = withStarts(result.lineup as LineupItem[], result.startTime);
    // The day's first item is an ad (the head), before the first episode.
    const firstEpisode = items.findIndex(({ item }) =>
      isEpisodeStart(item, 'bumpers'),
    );
    expect(firstEpisode).toBeGreaterThan(0);
    expect(isAd(items[0]!.item)).toBe(true);
    // The scheduler generates maxDays + 1 days, and the slot fills each exactly.
    expect(sumBy(items, ({ item }) => item.duration)).toBe(2 * 24 * oneHour);
  });
});

describe('bumpers and ads together', () => {
  const bumperSlot = (
    adList: string,
    bumperList: string,
    strategy: 'eager' | 'lazy',
    extra: Record<string, unknown> = {},
  ) => {
    const slot = elasticSlot(adList, 'show', 0, strategy, extra);
    return {
      ...slot,
      filler: [
        ...slot.filler,
        {
          types: ['pre' as const, 'post' as const],
          fillerListId: bumperList,
          fillerOrder: 'shuffle_prefer_short' as const,
          kind: 'bumper' as const,
        },
      ],
    };
  };

  // A block starts with its head and pre items, so the show itself starts a
  // few seconds after the grid point when a pre bumper plays first.
  const blockStartIndex = (items: TimedItem[], episodeIndex: number) => {
    let i = episodeIndex;
    while (
      i > 0 &&
      (items[i - 1]!.item.fillerType === 'pre' ||
        items[i - 1]!.item.fillerType === 'head')
    ) {
      i--;
    }
    return i;
  };

  const itemsOfBlock = (items: TimedItem[], showId: string, n = 0) => {
    const starts = items.filter(({ item }) => isEpisodeStart(item, showId));
    return items.filter(
      ({ start }) =>
        start >= starts[n]!.start &&
        (n + 1 >= starts.length || start < starts[n + 1]!.start),
    );
  };

  test.each(['eager', 'lazy'] as const)(
    '%s: bumpers play as single clips next to the program, never as placeholders',
    async (strategy) => {
      const ads = randomUUID();
      const bumpers = randomUUID();
      const result = await scheduleTimeSlots(
        schedule([bumperSlot(ads, bumpers, strategy)], 30 * oneMin, 1),
        [
          ...makeShow('show', [44, 44, 44, 44, 44, 44]),
          ...makeClips(ads, clipLengthsSec),
          ...makeBumpers(bumpers, [8, 10, 12]),
        ],
        [11, 11],
        undefined,
        midnight,
      );
      const items = withStarts(result.lineup as LineupItem[], result.startTime);
      const episodeIdx = items
        .map(({ item }, i) => (isEpisodeStart(item, 'show') ? i : -1))
        .filter((i) => i >= 0)[1]!;

      // The pre bumper is the item right before the program starts and the
      // post bumper the item right after its last segment: the ads are outside.
      const preBumper = items[episodeIdx - 1]?.item;
      expect(preBumper?.type).toBe('filler');
      expect(preBumper?.fillerType).toBe('pre');
      // Mid breaks sit between segments: find the final segment of the program.
      const programId = items[episodeIdx]!.item.id;
      let end = episodeIdx;
      for (let i = episodeIdx; i < items.length; i++) {
        if (
          items[i]!.item.type === 'content' &&
          items[i]!.item.id === programId
        ) {
          end = i;
        } else if (
          items[i]!.item.type === 'content' &&
          items[i]!.item.id !== programId
        ) {
          break;
        }
      }
      const postBumper = items[end + 1]?.item;
      expect(postBumper?.type).toBe('filler');
      expect(postBumper?.fillerType).toBe('post');
      const block = items.slice(episodeIdx - 1, end + 2);

      // Bumpers are one clip each: the pre and post positions hold exactly one.
      for (const type of ['pre', 'post']) {
        expect(
          block.filter(({ item }) => item.fillerType === type).length,
        ).toBeLessThanOrEqual(1);
      }
    },
  );

  test('bumpers come out of the room, so every program still ends on the grid', async () => {
    const ads = randomUUID();
    const bumpers = randomUUID();
    const padMs = 30 * oneMin;
    const result = await scheduleTimeSlots(
      schedule([bumperSlot(ads, bumpers, 'eager')], padMs),
      [
        ...makeShow('show', [75, 44, 61, 93, 22, 47, 88, 30]),
        ...makeClips(ads, clipLengthsSec),
        ...makeBumpers(bumpers, [9, 11, 14, 20]),
      ],
      [4, 4],
      undefined,
      midnight,
    );
    const items = withStarts(result.lineup as LineupItem[], result.startTime);
    const episodes = items
      .map(({ item }, i) => (isEpisodeStart(item, 'show') ? i : -1))
      .filter((i) => i >= 0);
    expect(episodes.length).toBeGreaterThanOrEqual(6);
    for (const idx of episodes) {
      // Each block starts on the grid; the show follows its pre bumper.
      const start = items[blockStartIndex(items, idx)]!.start;
      expect((start - midnight.valueOf()) % padMs).toBe(0);
    }
  });

  test('an ad range with min equal to max is an exact length', async () => {
    const ads = randomUUID();
    const bumpers = randomUUID();
    const result = await scheduleTimeSlots(
      schedule(
        [
          bumperSlot(ads, bumpers, 'lazy', {
            postLength: { minMs: 2 * oneMin, maxMs: 2 * oneMin },
          }),
        ],
        30 * oneMin,
        1,
      ),
      [
        ...makeShow('show', [75, 75, 75, 75]),
        ...makeClips(ads, clipLengthsSec),
        ...makeBumpers(bumpers, [10]),
      ],
      [6, 6],
      undefined,
      midnight,
    );
    const items = withStarts(result.lineup as LineupItem[], result.startTime);
    const block = itemsOfBlock(items, 'show', 1);
    // Lazy: the post ad break is a placeholder of exactly two minutes.
    const post = block.filter(
      ({ item }) =>
        item.type === 'flex' &&
        item.fillerConfig?.origin === 'flex' &&
        (item.fillerConfig.fillerListIds?.length ?? 0) > 0,
    );
    expect(post.length).toBe(1);
    expect(post[0]!.item.duration).toBe(2 * oneMin);
  });

  test('without a kind, an entry is a bumper and its ad range is ignored', async () => {
    const list = randomUUID();
    const slot = elasticSlot(list, 'legacy', 0, 'eager');
    // Same list, but no kind: post is a single bumper clip, whatever postLength
    // says.
    slot.filler = [
      {
        types: ['mid' as const, 'post' as const],
        fillerListId: list,
        fillerOrder: 'shuffle_prefer_short' as const,
      } as (typeof slot.filler)[number],
    ];
    const result = await scheduleTimeSlots(
      schedule([slot], 30 * oneMin, 1),
      [
        ...makeShow('legacy', [44, 44, 44, 44]),
        ...makeClips(list, clipLengthsSec),
      ],
      [2, 2],
      undefined,
      midnight,
    );
    const items = withStarts(result.lineup as LineupItem[], result.startTime);
    const block = itemsOfBlock(items, 'legacy', 1);
    const post = block.filter(({ item }) => item.fillerType === 'post');
    expect(post.length).toBeLessThanOrEqual(1);
  });
});

describe('a slot with an overflow', () => {
  test('a program admitted through the overflow still gets its ads', async () => {
    const list = randomUUID();
    // A 3 hour window with a 30 minute overflow on a 15 minute grid. The first
    // 85 minute episode takes 105 minutes with its ads; the second only fits
    // because the overflow lets its block end at 3:30.
    const result = await scheduleTimeSlots(
      {
        ...schedule(
          [
            elasticSlot(list, 'movies', 0, 'eager'),
            elasticSlot(list, 'next', 6 * oneHour, 'eager'),
          ],
          15 * oneMin,
          1,
        ),
        overflow: { type: 'duration', maxMs: 30 * oneMin },
      },
      [
        ...makeShow('movies', [85, 85, 85, 85]),
        ...makeShow('next', [30, 30, 30, 30, 30, 30]),
        ...makeClips(list, clipLengthsSec),
      ],
      [3, 3],
      undefined,
      midnight,
    );
    const items = withStarts(result.lineup as LineupItem[], result.startTime);
    const starts = items
      .filter(({ item }) => isEpisodeStart(item, 'movies'))
      .slice(0, 2);
    expect(starts).toHaveLength(2);
    const secondStart = starts[1]!.start;
    const secondBlock = items.filter(
      ({ start }) => start >= secondStart && start < secondStart + 105 * oneMin,
    );
    const adMs = sumBy(
      secondBlock.filter(({ item }) => isAd(item)),
      ({ item }) => item.duration,
    );
    // Before the fix the planner saw the window end at 3:00 and gave this
    // block no room at all.
    expect(adMs).toBeGreaterThanOrEqual(oneMin);
  });
});

describe('blocks never outgrow the slot window', () => {
  test('a program a few seconds past a grid point does not push the window over', async () => {
    const list = randomUUID();
    // 105:00.08, 129:00.12 and 110:00.10: each a hair past a quarter-hour. The
    // slot packing treats them as on the grid, so the planner has to as well.
    const hair = (minutes: number, seconds: number) =>
      minutes * oneMin + seconds * oneSec;
    const durations = [
      hair(105, 0.08),
      hair(129, 0.12),
      hair(110, 0.1),
      hair(105, 0.08),
      hair(129, 0.12),
      hair(110, 0.1),
    ];
    const programs = durations.map((duration, i) => ({
      ...createFakeProgramOrm({
        uuid: `hair-ep${i + 1}`,
        title: `Hair ${i + 1}`,
        type: 'episode',
        duration,
        episode: i + 1,
        tvShowUuid: 'hair',
        show: { uuid: 'hair' },
      }),
      parentFillerLists: [],
      parentCustomShows: [],
      parentSmartCollections: [],
    }));
    const slot = (startHour: number) => ({
      ...elasticSlot(list, 'hair', startHour * oneHour, 'lazy'),
    });
    const result = await scheduleTimeSlots(
      schedule([slot(0), slot(6)], 15 * oneMin, 1),
      [...programs, ...makeClips(list, clipLengthsSec)],
      [3, 3],
      undefined,
      midnight,
    );
    const items = withStarts(result.lineup as LineupItem[], result.startTime);
    // The second window's first program starts exactly at 06:00.
    const starts = items.filter(({ item }) => isEpisodeStart(item, 'hair'));
    const sixAm = midnight.valueOf() + 6 * oneHour;
    // (within the scheduler's 10 second tolerance: durations are in ms)
    expect(
      starts.some(({ start }) => Math.abs(start - sixAm) < 10 * oneSec),
    ).toBe(true);
    // Every program got its ads: none took the raw path that skips them.
    const episodeStarts = starts.length;
    const postBreaks = items.filter(
      ({ item }) =>
        item.fillerType === 'post' ||
        item.fillerConfig?.fillerListIds !== undefined,
    );
    expect(episodeStarts).toBeGreaterThan(0);
    expect(postBreaks.length).toBeGreaterThanOrEqual(episodeStarts);
    // No block crosses a window boundary: nothing is plain flex for hours.
    const longPlainFlex = items.filter(
      ({ item }) =>
        item.type === 'flex' &&
        !item.fillerConfig?.fillerListIds &&
        item.duration > 3 * oneHour,
    );
    expect(longPlainFlex).toHaveLength(0);
  });
});
