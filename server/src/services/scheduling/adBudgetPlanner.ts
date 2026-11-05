/**
 * Plans the ad time of one program in a time slot ("elastic ads").
 *
 * The planner is pure: it only does arithmetic on durations. It decides
 *
 *   1. where the program's block ends (a pad grid point),
 *   2. how much of the room before that point is ad time, and
 *   3. how that ad time is split over the filler positions.
 *
 * It does not pick clips. Clips are chosen by the slot's strategy (eager or
 * lazy) once the durations are known.
 *
 * All durations are milliseconds. "Relative" times are measured from the start
 * of the program.
 */

export type LengthRange = { minMs: number; maxMs: number };

export type SinglePosition = 'head' | 'pre' | 'post' | 'tail';

// Order in which positions are dropped when the budget cannot cover every
// minimum. Mid breaks and the post break are the last to go.
const DropOrder: SinglePosition[] = ['head', 'pre', 'tail', 'post'];

export const DefaultBreakLengthGridMs = 15_000;

export type AdPlanInput = {
  /** Content length of the program. */
  contentMs: number;
  /**
   * Time already spoken for next to the content: the bumper clips, which are
   * picked before the ads are planned. They are not ads and do not count
   * towards the ad share, but they take room.
   */
  fixedMs?: number;
  /**
   * How far past a pad grid point the program starts: (start mod padMs).
   * Zero when the program starts on the grid.
   */
  startPhaseMs: number;
  /** The pad grid. */
  padMs: number;
  /** Ad ratio range, as fractions of contentMs. */
  ratioMin: number;
  ratioMax: number;
  /**
   * The latest the block may end, relative to the program start. The caller
   * derives it from the slot's end and the room later programs still need.
   */
  latestEndMs: number;
  /** Length range of one mid break, when mid filler is configured. */
  mid?: LengthRange;
  /** How many mid break positions the break rule offers for this program. */
  midPositions: number;
  /** Length ranges of the positions that apply to this program. */
  singles: Partial<Record<SinglePosition, LengthRange>>;
  /** Planned lengths are multiples of this. */
  gridMs?: number;
  /**
   * Distance from a grid point within which content is treated as already on
   * it. Absorbs rounding noise in clip durations.
   */
  toleranceMs?: number;
  /**
   * The last block of a window: when its ads can cover everything up to
   * latestEndMs and stay within the ratio maximum and each position's maximum,
   * the block ends there instead of leaving the rest as fallback time.
   */
  extendToLatestEnd?: boolean;
  /**
   * Where the window ends, relative to the program start, when that is earlier
   * than latestEndMs. A slot with an overflow lets a block run past the
   * window (latestEndMs includes the overflow), but the last block should only
   * stretch to the window's own end. Defaults to latestEndMs.
   */
  windowEndMs?: number;
};

export type AdPlan = {
  /** Block length: content plus ads plus fallback time. Ends on the grid. */
  blockMs: number;
  /** Ad time, the sum of the planned pieces. */
  adMs: number;
  /** Room that no piece could use. Played as fallback filler or flex. */
  fallbackMs: number;
  /** One entry per planned mid break, in program order. */
  mid: number[];
  /** Indexes into the break rule's candidate positions, one per mid break. */
  midPositionIndexes: number[];
  head?: number;
  pre?: number;
  post?: number;
  tail?: number;
};

type Piece = {
  kind: SinglePosition | 'mid';
  lo: number;
  hi: number;
  value: number;
};

function ceilToGrid(valueMs: number, gridMs: number) {
  return Math.ceil(valueMs / gridMs) * gridMs;
}

function floorToGrid(valueMs: number, gridMs: number) {
  return Math.floor(valueMs / gridMs) * gridMs;
}

/**
 * The first grid point at or after `relMs`, relative to the program start.
 * `phaseMs` is how far past a grid point the program starts.
 */
export function gridPointAtOrAfter(
  relMs: number,
  phaseMs: number,
  padMs: number,
  toleranceMs = 0,
) {
  const abs = phaseMs + relMs - toleranceMs;
  return Math.ceil(abs / padMs) * padMs - phaseMs;
}

/** The last grid point at or before `relMs`, relative to the program start. */
export function gridPointAtOrBefore(
  relMs: number,
  phaseMs: number,
  padMs: number,
  toleranceMs = 0,
) {
  const abs = phaseMs + relMs + toleranceMs;
  return Math.floor(abs / padMs) * padMs - phaseMs;
}

/**
 * Snaps a range onto the break length grid: the minimum up, the maximum down.
 * Returns null when no multiple of the grid fits inside the range.
 */
function snapRange(range: LengthRange, gridMs: number, allowZero = false) {
  // An exact length (min equals max) is taken as it is: it is not a range to
  // spread a budget over, so it is not pushed onto the step.
  if (range.minMs === range.maxMs) {
    return range.minMs > 0 ? { lo: range.minMs, hi: range.maxMs } : null;
  }
  const lo = ceilToGrid(range.minMs, gridMs);
  const hi = floorToGrid(range.maxMs, gridMs);
  if (hi <= 0 || lo > hi) return null;
  // A position may be absent (minimum 0). A mid break never is.
  return { lo: allowZero && range.minMs === 0 ? 0 : Math.max(lo, gridMs), hi };
}

// Which position takes the next step when several are at the same length.
const TieOrder: Array<SinglePosition | 'mid'> = [
  'tail',
  'post',
  'pre',
  'head',
  'mid',
];

/**
 * Spends `budgetMs` over the pieces like a rising water level. Every piece
 * starts at its minimum, then the shortest one takes the next step, so all
 * positions climb together: post and tail catch up with the mid breaks, then
 * every position goes up a step at a time. The mid breaks are one group and
 * rise together, so no break ends up longer than another. A piece that reached
 * its maximum drops out and the others keep rising. When only the mid breaks
 * can still rise, and the rest does not fill a whole round, single mid breaks
 * take the remaining steps. The total never exceeds the budget.
 */
function waterFill(pieces: Piece[], budgetMs: number, gridMs: number) {
  for (const p of pieces) p.value = p.lo;
  let remaining = budgetMs - pieces.reduce((sum, p) => sum + p.lo, 0);
  if (remaining <= 0) return;

  const groups: Piece[][] = [];
  const mids = pieces.filter((p) => p.kind === 'mid');
  for (const p of pieces) {
    if (p.kind !== 'mid') groups.push([p]);
  }
  if (mids.length > 0) groups.push(mids);

  for (;;) {
    let best: Piece[] | undefined;
    for (const group of groups) {
      const cost = group.length * gridMs;
      if (cost > remaining) continue;
      if (group.some((p) => p.value + gridMs > p.hi)) continue;
      if (!best) {
        best = group;
        continue;
      }
      const level = group[0]!.value;
      const bestLevel = best[0]!.value;
      if (
        level < bestLevel ||
        (level === bestLevel &&
          TieOrder.indexOf(group[0]!.kind) < TieOrder.indexOf(best[0]!.kind))
      ) {
        best = group;
      }
    }
    if (!best) break;
    for (const p of best) p.value += gridMs;
    remaining -= best.length * gridMs;
  }

  // The other positions are at their maximum, or the mid breaks no longer fit
  // a whole round. What is left goes to the mid breaks one step at a time, the
  // shortest first, so some end up a step longer than the others.
  while (remaining >= gridMs) {
    let target: Piece | undefined;
    for (const p of mids) {
      if (p.value + gridMs > p.hi) continue;
      if (!target || p.value < target.value) target = p;
    }
    if (!target) return;
    target.value += gridMs;
    remaining -= gridMs;
  }
}

/** The most ad time the offered positions can hold. */
function adCapacity(input: AdPlanInput, gridMs: number): number {
  let total = 0;
  for (const kind of ['head', 'pre', 'post', 'tail'] as SinglePosition[]) {
    const range = input.singles[kind];
    const snapped = range ? snapRange(range, gridMs, true) : null;
    if (snapped) total += snapped.hi;
  }
  const mid = input.mid ? snapRange(input.mid, gridMs) : null;
  if (mid) total += mid.hi * Math.max(0, input.midPositions);
  return total;
}

export function planAds(input: AdPlanInput): AdPlan {
  const gridMs = input.gridMs ?? DefaultBreakLengthGridMs;
  const tolerance = input.toleranceMs ?? 0;
  const { contentMs, startPhaseMs, padMs } = input;
  const fixedMs = input.fixedMs ?? 0;

  // The smallest block that holds the content and its bumpers: ends on the
  // grid.
  const contentEnd = gridPointAtOrAfter(
    contentMs + fixedMs,
    startPhaseMs,
    padMs,
    tolerance,
  );

  // The block ends at the first grid point that holds the content, the
  // bumpers and the minimum ads, unless the slot (or the programs after this
  // one) cannot spare that much.
  const minAdMs = Math.round(contentMs * input.ratioMin);
  let blockMs = gridPointAtOrAfter(
    contentMs + fixedMs + minAdMs,
    startPhaseMs,
    padMs,
    tolerance,
  );
  if (blockMs > input.latestEndMs) {
    // No tolerance here: the block must not end after the window does, or the
    // overshoot carries into every block that follows.
    blockMs = gridPointAtOrBefore(input.latestEndMs, startPhaseMs, padMs, 0);
  }
  blockMs = Math.max(blockMs, contentEnd);

  // The last block of a window runs to the window's end when its ads can
  // absorb the rest: the most they can hold is the sum of the maximums.
  if (input.extendToLatestEnd) {
    const end = gridPointAtOrBefore(
      Math.min(input.latestEndMs, input.windowEndMs ?? input.latestEndMs),
      startPhaseMs,
      padMs,
      0,
    );
    if (end > blockMs) {
      const capacity = adCapacity(input, gridMs);
      const ratioCap = Math.floor(contentMs * input.ratioMax);
      if (end - contentMs - fixedMs <= Math.min(capacity, ratioCap)) {
        blockMs = end;
      }
    }
  }

  const room = Math.max(0, blockMs - contentMs - fixedMs);
  const adGoal = Math.min(room, Math.floor(contentMs * input.ratioMax));

  const empty: AdPlan = {
    blockMs,
    adMs: 0,
    fallbackMs: room,
    mid: [],
    midPositionIndexes: [],
  };
  if (adGoal <= 0) return empty;

  // Singles in time order, snapped to the grid. A position whose range cannot
  // hold a multiple of the grid is unusable.
  const singles: Piece[] = [];
  for (const kind of ['head', 'pre', 'post', 'tail'] as SinglePosition[]) {
    const range = input.singles[kind];
    if (!range) continue;
    const snapped = snapRange(range, gridMs, true);
    if (snapped) singles.push({ kind, ...snapped, value: 0 });
  }
  const midRange = input.mid ? snapRange(input.mid, gridMs) : null;

  // Drop positions, least important first, until the minimums fit.
  const sumLo = (ps: Piece[]) => ps.reduce((s, p) => s + p.lo, 0);
  for (const kind of DropOrder) {
    if (sumLo(singles) <= adGoal) break;
    const idx = singles.findIndex((p) => p.kind === kind);
    if (idx >= 0) singles.splice(idx, 1);
  }
  if (sumLo(singles) > adGoal) {
    singles.length = 0;
  }

  // How many mid breaks. The break rule offers positions; every one of them is
  // used as long as its minimum length still fits next to the minimums of the
  // other positions. Breaks are dropped only when the budget runs out. What is
  // left after that is spent by stretching the pieces towards their maximums.
  let midCount = 0;
  if (midRange && input.midPositions > 0) {
    const fits = Math.floor((adGoal - sumLo(singles)) / midRange.lo);
    midCount = Math.max(0, Math.min(input.midPositions, fits));
  }

  const midPieces: Piece[] = [];
  for (let i = 0; i < midCount; i++) {
    midPieces.push({
      kind: 'mid',
      lo: midRange!.lo,
      hi: midRange!.hi,
      value: 0,
    });
  }

  // Pieces in time order: head, pre, mid breaks, post, tail.
  const ordered: Piece[] = [
    ...singles.filter((p) => p.kind === 'head' || p.kind === 'pre'),
    ...midPieces,
    ...singles.filter((p) => p.kind === 'post' || p.kind === 'tail'),
  ];
  if (ordered.length === 0) return empty;

  // The minimum of every position is reserved first. The rest is shared out
  // evenly: all positions rise together, a step at a time.
  waterFill(ordered, adGoal, gridMs);

  const adMs = ordered.reduce((s, p) => s + p.value, 0);
  const plan: AdPlan = {
    blockMs,
    adMs,
    fallbackMs: room - adMs,
    mid: midPieces.map((p) => p.value),
    midPositionIndexes: spreadIndexes(midCount, input.midPositions),
  };
  for (const p of singles) plan[p.kind as SinglePosition] = p.value;
  return plan;
}

/** `count` indexes spread evenly over `positions` candidates. */
export function spreadIndexes(count: number, positions: number): number[] {
  if (count <= 0 || positions <= 0) return [];
  const n = Math.min(count, positions);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    out.push(Math.min(positions - 1, Math.floor(((k + 0.5) * positions) / n)));
  }
  return out;
}
