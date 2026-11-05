import type { CondensedChannelProgram, FillerProgram } from '@tunarr/types';
import {
  slotHasFiller,
  type BaseSlot,
  type MidRollConfig,
  type SlotFillerTypes,
} from '@tunarr/types/api';
import { isEmpty, some } from 'lodash-es';
import type { Random } from 'random-js';
import type { Nullable } from '../../types/util.ts';
import type { IterationState, ProgramIterator } from './ProgramIterator.js';

/**
 * A negative or non-finite {@link IterationState#slotDuration} is the caller's
 * way of saying "pick anything" (fallback filler), so only a finite,
 * non-negative budget constrains the pick.
 */
function fillerFitsAvailableTime(
  filler: FillerProgram,
  state: IterationState,
): boolean {
  if (!Number.isFinite(state.slotDuration) || state.slotDuration < 0) {
    return true;
  }
  return filler.duration <= state.slotDuration;
}

// Positions around a program where a slot can plan an ad break.
export type AdPosition = 'head' | 'pre' | 'post' | 'tail';

function isAdPosition(type: SlotFillerTypes): type is AdPosition {
  return (
    type === 'head' || type === 'pre' || type === 'post' || type === 'tail'
  );
}

export abstract class SlotImpl<
  SlotType extends BaseSlot,
  ProgramT extends CondensedChannelProgram = CondensedChannelProgram,
> {
  protected fillerIteratorsByType: Record<
    SlotFillerTypes,
    ProgramIterator<FillerProgram>[]
  > = {
    head: [],
    post: [],
    pre: [],
    tail: [],
    fallback: [],
    mid: [],
  };

  // Ad breaks around a program (kind 'ad' entries). They are kept apart from
  // the bumpers above so a bumper pick never draws from an ad list, and the
  // other way round. Mid breaks are always ads and live in the map above.
  protected adIteratorsByType: Record<
    AdPosition,
    ProgramIterator<FillerProgram>[]
  > = {
    head: [],
    pre: [],
    post: [],
    tail: [],
  };

  constructor(
    protected slot: SlotType,
    private iterator: ProgramIterator<ProgramT>,
    private random: Random,
    private fillerIteratorsByListId: Record<
      string,
      ProgramIterator<FillerProgram>
    > = {},
  ) {
    if (slotHasFiller(this.slot) && this.slot.filler) {
      for (const filler of this.slot.filler) {
        const it = this.fillerIteratorsByListId[filler.fillerListId];
        if (!it) {
          continue;
        }

        for (const type of filler.types) {
          if (filler.kind === 'ad' && isAdPosition(type)) {
            this.adIteratorsByType[type].push(it);
          } else if (filler.kind === 'ad' && type === 'fallback') {
            // Fallback is a last resort, not an ad position.
            continue;
          } else if (this.fillerIteratorsByType[type]) {
            this.fillerIteratorsByType[type].push(it);
          } else {
            this.fillerIteratorsByType[type] = [it];
          }
        }
      }
    }
  }

  getNextProgram(state: IterationState): ProgramT | null {
    return this.iterator.current(state);
  }

  /**
   * Can packing skip a program that does not fit and take a later one? Only a
   * shuffled slot can: skipping in an ordered slot would reorder its episodes.
   */
  canSkipPrograms(): boolean {
    return 'order' in this.slot && this.slot.order === 'shuffle';
  }

  advanceIterator(): void {
    return this.iterator.next();
  }

  getFillerOfType(
    type: SlotFillerTypes,
    state: IterationState,
  ): Nullable<FillerProgram> {
    return this.pickFiller(this.fillerIteratorsByType?.[type], type, state);
  }

  /** One clip for an ad break position, drawn from the slot's ad lists. */
  getAdFillerOfType(
    type: AdPosition,
    state: IterationState,
  ): Nullable<FillerProgram> {
    return this.pickFiller(this.adIteratorsByType[type], type, state);
  }

  private pickFiller(
    its: ProgramIterator<FillerProgram>[] | undefined,
    type: SlotFillerTypes,
    state: IterationState,
  ): Nullable<FillerProgram> {
    if (!its || isEmpty(its)) {
      return null;
    }

    // Random pick right now
    const it = this.random.pick(its);
    const filler = it.current(state);
    if (!filler) {
      return null;
    }

    it.next();

    // Not every iterator constrains its picks by the available time (index
    // based orderings such as "uniform" hand back whatever is next in the
    // shuffle). Reject an item that doesn't fit so it can't overflow the slot
    // -- the iterator has already advanced, so a retry gets a new candidate.
    if (!fillerFitsAvailableTime(filler, state)) {
      return null;
    }

    return { ...filler, fillerType: type };
  }

  hasFillerOfType(type: SlotFillerTypes) {
    const its = this.fillerIteratorsByType?.[type];
    return !isEmpty(its);
  }

  hasAdFillerOfType(type: AdPosition) {
    return !isEmpty(this.adIteratorsByType[type]);
  }

  /** Lists that fill an ad position, for the placeholders of lazy breaks. */
  getAdFillerListIdsOfType(type: AdPosition): string[] {
    if (!slotHasFiller(this.slot) || !this.slot.filler) return [];
    return this.slot.filler
      .filter((f) => f.kind === 'ad' && f.types.includes(type))
      .map((f) => f.fillerListId);
  }

  hasAnyFillerSettings() {
    return some(this.fillerIteratorsByType, (v) => !isEmpty(v));
  }

  getFillerListIdsOfType(type: SlotFillerTypes): string[] {
    if (!slotHasFiller(this.slot) || !this.slot.filler) return [];
    return this.slot.filler
      .filter((f) => f.types.includes(type))
      .map((f) => f.fillerListId);
  }

  getMidFillerListIds(): string[] {
    return this.getFillerListIdsOfType('mid');
  }

  /** The slot's bumper entries: its filler entries that are not ads. */
  get bumperEntries(): { types: SlotFillerTypes[]; fillerListId: string }[] {
    if (!slotHasFiller(this.slot) || !this.slot.filler) return [];
    return this.slot.filler
      .filter((entry) => entry.kind !== 'ad')
      .map(({ types, fillerListId }) => ({ types, fillerListId }));
  }

  get midRollConfig(): MidRollConfig | undefined {
    if (slotHasFiller(this.slot)) {
      return this.slot.midRoll;
    }
    return undefined;
  }

  get type() {
    return this.slot.type;
  }
}
