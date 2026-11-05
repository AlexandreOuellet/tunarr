import constants from '@tunarr/shared/constants';
import type {
  CondensedChannelProgram,
  FillerProgram,
  FlexProgram,
} from '@tunarr/types';
import type { BaseSlot, MidRollConfig } from '@tunarr/types/api';
import type { OfflineFillerConfig } from '@tunarr/types/schemas';
import type { NonEmptyArray } from 'ts-essentials';
import {
  DefaultBreakLengthGridMs,
  gridPointAtOrBefore,
  planAds,
  type AdPlan,
  type LengthRange,
} from './adBudgetPlanner.ts';
import { resolveBreakPoints } from './midRollBreakRules.ts';
import type { AdPosition, SlotImpl } from './SlotImpl.ts';
import { fillDurationWithFiller, PaddedProgram } from './slotSchedulerUtil.ts';

/**
 * Is elastic ad planning switched on for this slot? It needs the mid-roll
 * settings block (that is where the ratio and the ranges live) and a program
 * slot: filler slots hold no programs to plan around.
 */
export function usesElasticAds(slot: SlotImpl<BaseSlot>): boolean {
  return (
    slot.midRollConfig?.fitToSlot === true &&
    slot.midRollConfig.adRatioMax !== undefined &&
    slot.type !== 'filler'
  );
}

/** The longest bumper clip each position of a slot can draw. */
export function bumperReserveBySlot(
  slot: SlotImpl<BaseSlot>,
  programMap: { filler: Record<string, { duration: number }[] | undefined> },
): BumperReserve {
  const reserve: BumperReserve = {};
  for (const entry of slot.bumperEntries) {
    const clips = programMap.filler[`filler.${entry.fillerListId}`] ?? [];
    const longest = clips.reduce(
      (max, clip) => Math.max(max, clip.duration),
      0,
    );
    for (const type of entry.types) {
      if (
        type === 'head' ||
        type === 'pre' ||
        type === 'post' ||
        type === 'tail'
      ) {
        reserve[type] = Math.max(reserve[type] ?? 0, longest);
      }
    }
  }
  return reserve;
}

/** The longest bumper clip of each position, from the slot's bumper lists. */
export type BumperReserve = Partial<Record<BumperPosition, number>>;

/**
 * The time a program must be able to hold next to its content: the minimum of
 * every ad position that applies to it, plus the bumper at that position (the
 * longest clip its list holds, since a bumper is one clip picked later).
 *
 * Head applies to the first program of a window, tail to its last, pre, mid and
 * post to every program. Slot packing adds this to the program's content before
 * rounding to the grid, so a window is not packed with a program that leaves
 * its required ads no room.
 */
export function requiredAdMs(
  slot: SlotImpl<BaseSlot>,
  config: MidRollConfig,
  program: CondensedChannelProgram,
  bumpers: BumperReserve,
  where: { first: boolean; last: boolean },
): number {
  if (program.type !== 'content' && program.type !== 'custom') return 0;
  const positions: BumperPosition[] = [
    ...(where.first ? (['head'] as const) : []),
    'pre',
    'post',
    ...(where.last ? (['tail'] as const) : []),
  ];
  let required = 0;
  for (const position of positions) {
    required += bumpers[position] ?? 0;
    const range = config[AdLengthKeys[position]];
    if (range && slot.hasAdFillerOfType(position)) {
      required += range.minMs;
    }
  }
  const splittable =
    slot.getMidFillerListIds().length > 0 &&
    isProgramTypeAllowed(program, config) &&
    (resolveBreakPoints(program.duration, config) ?? []).length > 0;
  if (splittable) required += config.breakDurationMinMs ?? 0;
  return required;
}

type ElasticArgs = {
  /** The slot's programs, padded to the grid by their content length. */
  paddedPrograms: NonEmptyArray<PaddedProgram>;
  slot: SlotImpl<BaseSlot>;
  config: MidRollConfig;
  /** When the slot's first program starts, epoch ms. */
  timeCursor: number;
  /** How far past a pad grid point the first program starts. */
  startPhaseMs: number;
  padMs: number;
  slotDurationMs: number;
  /**
   * How far a block may run past the window (the slot's overflow). Packing
   * admits a program that fits only with it, so the ads are planned with it.
   */
  overflowMs?: number;
};

type BumperPosition = 'head' | 'pre' | 'post' | 'tail';

const AdLengthKeys = {
  head: 'headLength',
  pre: 'preLength',
  post: 'postLength',
  tail: 'tailLength',
} as const;

/**
 * Plans every program of a slot and lays out the items of each block, from the
 * outside in: head bumper, head ads, pre ads, pre bumper, the content split by
 * mid breaks, post bumper, post ads, tail ads, tail bumper, then the leftover
 * as fallback time. Every block ends on the pad grid.
 *
 * Bumpers are single clips picked when the schedule is generated, so their
 * lengths are known first. They come out of the block's room, and the ads are
 * planned into what is left.
 */
export function applyElasticAds({
  paddedPrograms,
  slot,
  config,
  timeCursor,
  startPhaseMs,
  padMs,
  slotDurationMs,
  overflowMs = 0,
}: ElasticArgs): PaddedProgram[] {
  const result: PaddedProgram[] = [];
  const gridMs = config.breakLengthGridMs ?? DefaultBreakLengthGridMs;
  let elapsedMs = 0;

  // The least room each later program needs: its content rounded to the grid.
  const minBlocks = paddedPrograms.map((pp) => pp.totalDuration);
  const lastIndex = paddedPrograms.length - 1;

  paddedPrograms.forEach((pp, index) => {
    const program = pp.program;
    const laterMs = minBlocks.slice(index + 1).reduce((a, b) => a + b, 0);
    const startMs = timeCursor + elapsedMs;
    const phase = (((startPhaseMs + elapsedMs) % padMs) + padMs) % padMs;
    const latestEndMs = slotDurationMs + overflowMs - elapsedMs - laterMs;
    const windowEndMs = slotDurationMs - elapsedMs;

    // Head belongs to the slot's first program, tail to its last.
    const positions: BumperPosition[] = [
      ...(index === 0 ? (['head'] as const) : []),
      'pre',
      'post',
      ...(index === lastIndex ? (['tail'] as const) : []),
    ];

    // 1. Bumpers first. They may not push the block past what the slot can
    // spare, so each pick is limited to the room that is left.
    const bumperRoomMs = Math.max(
      0,
      gridPointAtOrBefore(latestEndMs, phase, padMs, constants.SLACK) -
        program.duration,
    );
    const bumpers = pickBumpers(slot, positions, bumperRoomMs, startMs);
    const fixedMs = Object.values(bumpers).reduce((s, b) => s + b.duration, 0);

    // 2. The ads, planned into the room that is left.
    const splittable =
      (program.type === 'content' || program.type === 'custom') &&
      slot.getMidFillerListIds().length > 0 &&
      isProgramTypeAllowed(program, config);
    const breakPoints = splittable
      ? (resolveBreakPoints(program.duration, config) ?? [])
      : [];

    const singles: Partial<Record<AdPosition, LengthRange>> = {};
    for (const position of positions) {
      const range = config[AdLengthKeys[position]];
      if (range && slot.hasAdFillerOfType(position)) {
        singles[position] = range;
      }
    }

    const plan = planAds({
      contentMs: program.duration,
      fixedMs,
      startPhaseMs: phase,
      padMs,
      ratioMin: config.adRatioMin ?? 0,
      ratioMax: config.adRatioMax ?? 0,
      latestEndMs,
      mid: splittable
        ? {
            minMs: config.breakDurationMinMs ?? 0,
            maxMs: config.breakDurationMaxMs ?? 0,
          }
        : undefined,
      midPositions: breakPoints.length,
      singles,
      gridMs,
      // The same tolerance the slot packing uses (createPaddedProgram): a
      // program a few seconds past a grid point counts as on it. If the
      // planner rounded it up instead, the blocks could add up to more than
      // the window the packing fitted them into.
      toleranceMs: constants.SLACK,
      extendToLatestEnd: index === lastIndex,
      windowEndMs,
    });

    const block = layOutBlock(
      pp,
      plan,
      bumpers,
      breakPoints,
      slot,
      config,
      startMs,
    );
    // The clips of a pod can add up to a few milliseconds more than the plan.
    // Take that back out of the block's own padding, so the next program
    // starts on the grid and the error does not add up over a year.
    let overshootMs =
      block.reduce((sum, pp) => sum + pp.totalDuration, 0) - plan.blockMs;
    for (let i = block.length - 1; i >= 0 && overshootMs > 0; i--) {
      const pp = block[i]!;
      const take = Math.min(pp.padMs, overshootMs);
      pp.padMs -= take;
      overshootMs -= take;
    }
    result.push(...block);
    // Count what the block really takes, not what was planned: content that
    // runs a few seconds past a grid line (the packing ignores up to 10 s) is
    // then taken back by the next block's ads, so the grid does not drift.
    elapsedMs += Math.max(
      plan.blockMs,
      block.reduce((sum, pp) => sum + pp.totalDuration, 0),
    );
  });

  return result;
}

/**
 * Picks the bumper clips of a program, in time order, each limited to the room
 * that is left. A bumper is one clip and is never resolved at playback.
 */
function pickBumpers(
  slot: SlotImpl<BaseSlot>,
  positions: BumperPosition[],
  roomMs: number,
  startMs: number,
): Partial<Record<BumperPosition, FillerProgram>> {
  const picked: Partial<Record<BumperPosition, FillerProgram>> = {};
  let remaining = roomMs;
  for (const position of positions) {
    if (remaining <= 0 || !slot.hasFillerOfType(position)) continue;
    // A pick that does not fit counts as a miss, as in the single-clip filler
    // code, so a few tries.
    for (let attempt = 0; attempt < 3; attempt++) {
      const clip = slot.getFillerOfType(position, {
        slotDuration: remaining,
        timeCursor: startMs,
        cooldownMs: 0,
      });
      if (clip && clip.duration > 0 && clip.duration <= remaining) {
        picked[position] = clip;
        remaining -= clip.duration;
        break;
      }
    }
  }
  return picked;
}

function isProgramTypeAllowed(
  program: CondensedChannelProgram,
  config: MidRollConfig,
) {
  if (!config.programTypes) return true;
  const subtype = (program as { subtype?: string }).subtype;
  return !subtype || config.programTypes.includes(subtype as never);
}

function layOutWhole(
  pp: PaddedProgram,
  plan: AdPlan,
  bumpers: Partial<Record<BumperPosition, FillerProgram>>,
): PaddedProgram[] {
  const whole = new PaddedProgram(pp.program, plan.fallbackMs, {});
  for (const [position, clip] of Object.entries(bumpers)) {
    whole.filler[position as BumperPosition] = clip;
  }
  const total = whole.totalDuration;
  const drift = plan.blockMs - total;
  if (drift !== 0) {
    whole.padMs = Math.max(0, whole.padMs + drift);
  }
  return [whole];
}

function layOutBlock(
  pp: PaddedProgram,
  plan: AdPlan,
  bumpers: Partial<Record<BumperPosition, FillerProgram>>,
  breakPoints: { offsetMs: number }[],
  slot: SlotImpl<BaseSlot>,
  config: MidRollConfig,
  startMs: number,
): PaddedProgram[] {
  // Only content and custom programs are cut into segments. Anything else is
  // laid out as it is: it gets no mid breaks and keeps its own fields.
  if (pp.program.type !== 'content' && pp.program.type !== 'custom') {
    return layOutWhole(pp, plan, bumpers);
  }
  const program = pp.program;
  const lazy = config.strategy === 'lazy';
  const baseOffset = (program as { startOffsetMs?: number }).startOffsetMs ?? 0;
  const items: PaddedProgram[] = [];
  // Eager clips can fall short of a planned break; the shortfall joins the
  // block's fallback time so the block keeps its planned length.
  let shortfallMs = 0;

  const placeholder = (
    type: 'mid' | AdPosition,
    durationMs: number,
  ): FlexProgram => {
    const ids =
      type === 'mid'
        ? slot.getMidFillerListIds()
        : slot.getAdFillerListIdsOfType(type);
    const fillerConfig: OfflineFillerConfig = {
      fillerListIds: ids.length > 0 ? ids : undefined,
      origin: type === 'mid' ? 'midroll' : 'flex',
    };
    return { type: 'flex', duration: durationMs, fillerConfig };
  };

  const fillPosition = (
    type: AdPosition,
    durationMs: number | undefined,
    cursor: number,
  ): CondensedChannelProgram[] => {
    if (!durationMs) return [];
    if (lazy) return [placeholder(type, durationMs)];
    const filled = fillDurationWithFiller(
      slot,
      durationMs,
      cursor,
      10,
      type,
      true,
    );
    shortfallMs += durationMs - filled.totalDuration;
    return filled.fillers;
  };

  // Clips are picked in time order: the repeat cooldown works on the time
  // cursor, so an earlier position filled after a later one would see the
  // later clips as just played.
  const headBumperMs = bumpers.head?.duration ?? 0;
  const headPod = fillPosition('head', plan.head, startMs + headBumperMs);
  const headAdsMs = plan.head ?? 0;
  const prePod = fillPosition(
    'pre',
    plan.pre,
    startMs + headBumperMs + headAdsMs,
  );

  // Mid breaks cut the content at the chosen positions, in time order.
  const cuts = plan.midPositionIndexes
    .map((i) => breakPoints[i]!.offsetMs)
    .sort((a, b) => a - b);
  let segmentStart = 0;
  plan.mid.forEach((breakMs, k) => {
    const cut = cuts[k]!;
    items.push(
      new PaddedProgram(
        {
          ...program,
          duration: cut - segmentStart,
          startOffsetMs: baseOffset + segmentStart,
        },
        0,
        {},
      ),
    );
    if (lazy) {
      items.push(new PaddedProgram(placeholder('mid', breakMs), 0, {}));
    } else {
      const filled = fillDurationWithFiller(
        slot,
        breakMs,
        startMs + cut,
        10,
        'mid',
      );
      for (const clip of filled.fillers) {
        items.push(new PaddedProgram(clip, 0, {}));
      }
      const remainder = breakMs - filled.totalDuration;
      if (remainder > 0) {
        // Break time the clips could not cover stays a break, not fallback.
        const flex: FlexProgram = {
          type: 'flex',
          duration: remainder,
          fillerConfig: { origin: 'midroll' },
        };
        items.push(new PaddedProgram(flex, 0, {}));
      }
    }
    segmentStart = cut;
  });

  const lastSegment = new PaddedProgram(
    {
      ...program,
      duration: program.duration - segmentStart,
      startOffsetMs: baseOffset + segmentStart,
    },
    0,
    {},
  );
  items.push(lastSegment);

  // Head and pre bumpers and ads open the first segment; post and tail close
  // the last. The lineup writes them from the outside in.
  const first = items[0]!;
  if (bumpers.head) first.filler.head = bumpers.head;
  if (bumpers.pre) first.filler.pre = bumpers.pre;
  first.pods.head = headPod;
  first.pods.pre = prePod;

  const contentEnd =
    startMs + program.duration + plan.mid.reduce((a, b) => a + b, 0);
  const postBumperMs = bumpers.post?.duration ?? 0;
  if (bumpers.post) lastSegment.filler.post = bumpers.post;
  if (bumpers.tail) lastSegment.filler.tail = bumpers.tail;
  lastSegment.pods.post = fillPosition(
    'post',
    plan.post,
    contentEnd + postBumperMs,
  );
  lastSegment.pods.tail = fillPosition(
    'tail',
    plan.tail,
    contentEnd + postBumperMs + (plan.post ?? 0),
  );

  // Whatever nothing could fill is fallback time at the end of the block.
  lastSegment.padMs = plan.fallbackMs + shortfallMs;

  // The block always totals the planned length. Rounding in clip durations
  // can leave a few milliseconds either way: absorb them in the fallback time.
  const total = items.reduce((sum, p) => sum + p.totalDuration, 0);
  const drift = plan.blockMs - total;
  if (drift !== 0) {
    lastSegment.padMs = Math.max(0, lastSegment.padMs + drift);
  }
  return items;
}
