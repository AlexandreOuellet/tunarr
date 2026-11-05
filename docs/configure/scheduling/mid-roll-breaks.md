# Mid-Roll Breaks

Mid-roll breaks insert commercial-style breaks _within_ programs, splitting a long movie or episode into segments separated by filler content. This simulates the experience of traditional TV commercial breaks.

Mid-roll breaks are configured per-slot in the [Slot Editor](random-slots.md) and [Time Slots](time-slots.md) editors. Any slot type that supports [filler](../library/filler.md) also supports mid-roll breaks.

## Prerequisites

To use mid-roll breaks, you need:

1. A [filler list](../library/filler.md) with content (commercials, bumpers, etc.)
2. The filler list assigned to a slot with the **Mid** filler type

When editing a slot in the Slot Editor or Time Slots editor, add a filler list and select "Mid" as one of its types. Once a "Mid" filler is assigned, the mid-roll configuration panel appears.

## Break Positioning

Mid-roll breaks support three positioning rules that control _where_ breaks are inserted within a program.

### Fixed Interval

Inserts breaks at regular time intervals throughout the program.

| Setting | Description |
|---------|-------------|
| **Interval** | Time between breaks (e.g., every 30 minutes) |

A 2-hour movie with a 30-minute interval gets breaks at 30m, 60m, and 90m.

### Percentage-Based

Inserts breaks at specific points expressed as percentages of the program's total duration.

| Setting | Description |
|---------|-------------|
| **Points** | One or more percentage values (1–99%) |

A 2-hour movie with points at 25%, 50%, and 75% gets breaks at 30m, 60m, and 90m.

### Initial Delay + Interval

Combines an initial delay before the first break with a regular interval for subsequent breaks.

| Setting | Description |
|---------|-------------|
| **Initial Delay** | Time before the first break |
| **Interval** | Time between subsequent breaks |

A 2-hour movie with a 15-minute initial delay and 30-minute interval gets breaks at 15m, 45m, 75m, and 105m.

## Break Duration

Break duration can be configured in two modes:

- **Fixed**: Every break has the same duration (e.g., 3 minutes).
- **Range**: Each break's duration is randomly chosen between a minimum and maximum value (e.g., 2–5 minutes). This makes breaks feel less mechanical.

In a time slot, breaks only use the slot's spare time, which is the padding and flex left after its programs. They never push the slot past its end, so the next slot still starts on time. When the spare time runs low, a break is shortened to fit, but never below the minimum break duration (or the fixed duration). A break that cannot fit at that length is dropped, along with the rest of that program's breaks. For example, a 53-minute episode in a one-hour slot gets at most 7 minutes of breaks. A program's breaks use its own padding first, so the programs after it keep their start times.

## Limits and Filters

| Setting | Description | Default |
|---------|-------------|---------|
| **Max Breaks** | Maximum number of breaks per program. 0 = unlimited. | 0 |
| **Minimum Program Duration** | Programs shorter than this are skipped entirely. | Fitted to the slot |
| **Tail Buffer** | Minimum amount of content preserved at the end of the program before the credits. No breaks are inserted within this window. | 0 |
| **Program Types** | Restrict mid-roll to specific content types (Movies, Episodes, Music Tracks, Music Videos, Other Videos). Empty = all types. | All |

### Starting Values

When mid-roll is first enabled on a slot, the interval and minimum program
duration are fitted to the programs that slot actually draws from: the interval
aims for about two breaks in a program of typical length, and the minimum sits
at or below the shortest program in the pool, so none of the slot's own content
is skipped. A slot whose pool cannot be measured — a smart collection, or a
channel whose programs have not loaded — starts at a 15 minute interval and a
20 minute minimum.

These are starting values, not rules. Raise the minimum to leave shorter
programs whole.

## Scheduling Strategy

The scheduling strategy controls _when_ filler content is selected for mid-roll breaks.

### Eager

Filler is selected at **schedule generation time**. The specific filler programs are embedded directly into the channel lineup.

- The TV guide shows the actual filler titles during breaks.
- Filler selection uses cooldown state from the time the schedule was generated.
- Any part of a break that the filler lists cannot fill becomes flex. It is still
  break time, so the TV guide labels it "Commercial Break".

### Lazy

Filler selection is deferred to **stream time** — the moment a viewer is actually watching the channel. During schedule generation, placeholder "Commercial Break" entries are created.

- The TV guide shows generic "Commercial Break" entries.
- Filler selection uses fresh cooldown state, reducing repeats.
- Filler is drawn from the slot's mid-roll filler lists.

!!! tip
    Use the **Lazy** strategy if you want the most variety in your filler content. Because filler is picked at playback time, the system has up-to-date knowledge of what has recently played and can avoid repeats more effectively.

## In the Lineup Editor

A program that was split by mid-roll breaks appears as a single collapsed row in
the channel's program list, labelled with the number of breaks and showing where
they fall across the program. Expand the row to see each segment and each break
on its own line. This applies to both strategies.

## Example Configuration

To add 3-minute commercial breaks every 30 minutes to movies longer than 1 hour:

1. Open a slot in the Slot Editor or Time Slots editor.
2. Add a filler list and select the **Mid** type.
3. In the mid-roll configuration panel:
    - **Break Rule**: Fixed Interval, 30 minutes
    - **Break Duration**: Fixed, 3 minutes
    - **Minimum Program Duration**: 60 minutes
    - **Max Breaks**: 0 (unlimited)
    - **Strategy**: Lazy
    - **Program Types**: Movies only

## Elastic Ad Budget

A slot's filler comes in two kinds, on two tabs of the slot editor:

- **Bumpers** are single short clips: a station ident, a "sponsored by" card.
  They keep working as they always have (head, pre, post, tail and fallback),
  and they are always picked when the schedule is generated.
- **Ads** are breaks of several clips that fill a length you set (head, pre,
  mid, post and tail), the way a mid-roll break does.

By default a mid-roll break has a fixed length (or a random one inside a
range), and the total ad time is the number of breaks times that length. The
**Elastic Ad Budget** option on the Ads tab plans the ad time of each program
from the program's length instead. It applies to **time slots**.

For each program, Tunarr:

1. Picks the bumpers first. Their lengths are then known.
2. Takes the content length, the bumpers and the **minimum ad share**, and
   rounds that up to the next point on the slot's pad grid. That point is where
   the program's block ends, so the next program starts on the grid.
3. Spends the room up to that point on ads, never more than the **maximum ad
   share** of the content length. The break rule offers positions for mid
   breaks, and every one of them is used as long as the budget holds its
   minimum length. Mid breaks and every ad position that has a length share the
   budget. A range is spread in steps of the **break length
   step** (5 to 30 seconds). A minimum equal to the maximum is an exact length.
4. Plays whatever is left as fallback filler (or flex when the slot has none).

From the outside in, a block plays: head bumper, head ads, pre ads, pre bumper,
the program (with its mid ads), post bumper, post ads, tail ads, tail bumper.
Head and tail belong to the slot's first and last program.

The block never grows past the slot's end, and never takes the room that later
programs in the slot need to end on their own grid points. A program with
little room gets as many ads as fit, down to none.

| Content | Pad grid | Block ends | Ads (15-20%) | Fallback |
| ------- | -------- | ---------- | ------------ | -------- |
| 75 min  | 15 min   | 90:00      | 15:00        | 0        |
| 61 min  | 30 min   | 90:00      | about 12:10  | 16:50    |
| 61 min  | 15 min   | 75:00      | about 12:10  | 1:50     |
| 93 min  | 30 min   | 120:00     | about 18:35  | 8:25     |

To use it, add a filler list on the **Ads** tab, tick the positions it should
play in, and enable **Plan ad time from the program length**. Every ad position
other than mid needs a length. Mid breaks use the break duration range on the
Mid-Roll tab, which must be set to **Range**. Both the eager and the lazy
strategy work for ads. The planned lengths are the same, and the strategy
decides when the clips are picked. Bumpers are not affected by the strategy.

!!! note
    Existing slots keep working. A filler entry without a kind is a bumper, and
    a mid break is an ad. When you open an old slot, an entry that mixed mid
    with other types is split into an ad entry and a bumper entry for the same
    list.
