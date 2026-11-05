import type { SlotFiller } from '@tunarr/types/api';

/**
 * Whether a filler entry is an ad entry. Entries without a kind are bumpers,
 * except that a mid break has always been an ad: it fills a duration.
 */
export function isAdEntry(filler: Pick<SlotFiller, 'kind'>): boolean {
  return filler.kind === 'ad';
}

/**
 * Gives every filler entry an explicit kind, so the Bumpers and Ads tabs each
 * own a clean set of entries. An old entry that mixed mid with other types is
 * split in two: its mid type becomes an ad entry, and the rest a bumper entry
 * for the same list. Nothing about the schedule changes by doing this.
 */
export function normalizeFillerKinds(filler: SlotFiller[]): SlotFiller[] {
  const out: SlotFiller[] = [];
  for (const entry of filler) {
    if (entry.kind !== undefined) {
      out.push(entry);
      continue;
    }
    const hasMid = entry.types.includes('mid');
    const others = entry.types.filter((t) => t !== 'mid');
    if (hasMid) {
      out.push({ ...entry, types: ['mid'], kind: 'ad' });
    }
    if (others.length > 0) {
      out.push({
        ...entry,
        types: others,
        kind: 'bumper',
      });
    }
  }
  return out;
}

/** True when normalizing would change anything. */
export function needsKindNormalization(filler: SlotFiller[]): boolean {
  return filler.some((f) => f.kind === undefined);
}
