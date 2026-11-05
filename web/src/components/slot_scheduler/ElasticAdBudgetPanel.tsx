import type { MessageDescriptor } from '@lingui/core';
import { i18n } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  Box,
  Checkbox,
  Chip,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo } from 'react';
import { Controller, useFormContext } from 'react-hook-form';

type LengthRange = { minMs: number; maxMs: number };
type LengthKey = 'headLength' | 'preLength' | 'postLength' | 'tailLength';

type ElasticFormFields = {
  filler?: { types?: string[]; kind?: 'bumper' | 'ad' }[];
  midRoll: {
    fitToSlot?: boolean;
    adRatioMin?: number;
    adRatioMax?: number;
    headLength?: LengthRange;
    preLength?: LengthRange;
    postLength?: LengthRange;
    tailLength?: LengthRange;
    breakLengthGridMs?: number;
    breakDurationMs?: number;
    breakDurationMinMs?: number;
    breakDurationMaxMs?: number;
  };
};

// The ad positions around a program that take a planned length. Mid breaks use
// the break duration range on the Mid-Roll tab.
const lengthPositions: {
  key: LengthKey;
  type: 'head' | 'pre' | 'post' | 'tail';
  label: MessageDescriptor;
  defaults: LengthRange;
}[] = [
  {
    key: 'headLength',
    type: 'head',
    label: msg`Head ads (start of the slot)`,
    defaults: { minMs: 30_000, maxMs: 60_000 },
  },
  {
    key: 'preLength',
    type: 'pre',
    label: msg`Pre ads (before each program)`,
    defaults: { minMs: 30_000, maxMs: 60_000 },
  },
  {
    key: 'postLength',
    type: 'post',
    label: msg`Post ads (after each program)`,
    defaults: { minMs: 60_000, maxMs: 300_000 },
  },
  {
    key: 'tailLength',
    type: 'tail',
    label: msg`Tail ads (end of the slot)`,
    defaults: { minMs: 30_000, maxMs: 120_000 },
  },
];

const breakLengthGridOptions = [5, 10, 15, 20, 30];

const DefaultBreakRangeMs = { minMs: 120_000, maxMs: 180_000 };

/** The order things play in, from the outside in, for one program. */
const OrderStrip = () => {
  const bumper = (label: string) => (
    <Chip size="small" variant="outlined" color="secondary" label={label} />
  );
  const ads = (label: string) => (
    <Chip size="small" color="primary" label={label} />
  );
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {bumper(t`Head bumper`)}
      {ads(t`Head ads`)}
      {ads(t`Pre ads`)}
      {bumper(t`Pre bumper`)}
      <Chip size="small" label={t`Program (with mid ads)`} />
      {bumper(t`Post bumper`)}
      {ads(t`Post ads`)}
      {ads(t`Tail ads`)}
      {bumper(t`Tail bumper`)}
    </Box>
  );
};

/**
 * The elastic ad budget: each program gets a share of its length as ad time,
 * its block is rounded up to the pad grid, and the budget is spread over the
 * ad positions below. Bumpers are not part of the budget; they are picked first
 * and take their length out of the room.
 */
export const ElasticAdBudgetPanel = () => {
  const { control, watch, setValue, getValues } =
    useFormContext<ElasticFormFields>();
  const fitToSlot = watch('midRoll.fitToSlot');
  const filler = watch('filler');

  // Which positions have an ad list. Only those take part, and each needs a
  // length: there is no ad position without one.
  const adTypes = useMemo(
    () =>
      new Set(
        (filler ?? [])
          .filter((f) => f.kind === 'ad')
          .flatMap((f) => f.types ?? []),
      ),
    [filler],
  );

  useEffect(() => {
    if (fitToSlot !== true) return;
    for (const { key, type, defaults } of lengthPositions) {
      if (adTypes.has(type) && getValues(`midRoll.${key}`) === undefined) {
        setValue(`midRoll.${key}`, defaults);
      }
    }
  }, [fitToSlot, adTypes, getValues, setValue]);

  const handleEnable = (enabled: boolean) => {
    if (!enabled) {
      setValue('midRoll.fitToSlot', undefined);
      return;
    }
    setValue('midRoll.fitToSlot', true);
    if (getValues('midRoll.adRatioMax') === undefined) {
      setValue('midRoll.adRatioMin', 0.15);
      setValue('midRoll.adRatioMax', 0.2);
    }
    // Planned mid breaks need a length range, not a fixed length.
    if (getValues('midRoll.breakDurationMinMs') === undefined) {
      setValue('midRoll.breakDurationMs', undefined);
      setValue('midRoll.breakDurationMinMs', DefaultBreakRangeMs.minMs);
      setValue('midRoll.breakDurationMaxMs', DefaultBreakRangeMs.maxMs);
    }
  };

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2">
        <Trans>Elastic Ad Budget</Trans>
      </Typography>
      <FormControlLabel
        control={
          <Checkbox
            checked={fitToSlot === true}
            onChange={(e) => handleEnable(e.target.checked)}
          />
        }
        label={t`Plan ad time from the program length`}
      />
      <Typography variant="caption" color="text.secondary">
        <Trans>
          Each program gets an ad budget as a share of its length. Mid breaks
          are placed at the positions from the Mid-Roll tab, as many as the
          budget allows, each between its minimum and maximum length. The block
          is rounded up to the pad grid, so the next program starts on it.
          Bumpers are not part of the budget.
        </Trans>
      </Typography>
      <OrderStrip />

      {fitToSlot === true && (
        <Stack spacing={2}>
          <Stack direction="row" spacing={2}>
            <Controller
              control={control}
              name="midRoll.adRatioMin"
              render={({ field }) => (
                <TextField
                  fullWidth
                  label={t`Minimum ad share (%)`}
                  type="number"
                  slotProps={{ htmlInput: { min: 0, max: 100, step: 1 } }}
                  value={
                    field.value !== undefined
                      ? Math.round(field.value * 1000) / 10
                      : ''
                  }
                  onChange={(e) => field.onChange(Number(e.target.value) / 100)}
                  helperText={t`The block grows to the next grid point to fit this`}
                />
              )}
            />
            <Controller
              control={control}
              name="midRoll.adRatioMax"
              render={({ field }) => (
                <TextField
                  fullWidth
                  label={t`Maximum ad share (%)`}
                  type="number"
                  slotProps={{ htmlInput: { min: 1, max: 100, step: 1 } }}
                  value={
                    field.value !== undefined
                      ? Math.round(field.value * 1000) / 10
                      : ''
                  }
                  onChange={(e) => field.onChange(Number(e.target.value) / 100)}
                  helperText={t`Ads never exceed this share. Time beyond it plays as fallback filler`}
                />
              )}
            />
          </Stack>

          <Typography variant="body2" color="text.secondary">
            <Trans>
              Give each ad position a length. A minimum equal to the maximum is
              an exact length. Mid ads use the break duration on the Mid-Roll
              tab.
            </Trans>
          </Typography>

          {lengthPositions
            .filter(({ type }) => adTypes.has(type))
            .map(({ key, label, defaults }) => (
              <Stack key={key} spacing={1}>
                <Typography variant="body2">{i18n.t(label)}</Typography>
                <Stack direction="row" spacing={2}>
                  <Controller
                    control={control}
                    name={`midRoll.${key}.minMs` as const}
                    render={({ field }) => (
                      <TextField
                        fullWidth
                        size="small"
                        label={t`Min (seconds)`}
                        type="number"
                        slotProps={{ htmlInput: { min: 1 } }}
                        value={
                          field.value !== undefined
                            ? Math.round(Number(field.value) / 1000)
                            : defaults.minMs / 1000
                        }
                        onChange={(e) =>
                          field.onChange(Number(e.target.value) * 1000)
                        }
                      />
                    )}
                  />
                  <Controller
                    control={control}
                    name={`midRoll.${key}.maxMs` as const}
                    render={({ field }) => (
                      <TextField
                        fullWidth
                        size="small"
                        label={t`Max (seconds)`}
                        type="number"
                        slotProps={{ htmlInput: { min: 1 } }}
                        value={
                          field.value !== undefined
                            ? Math.round(Number(field.value) / 1000)
                            : defaults.maxMs / 1000
                        }
                        onChange={(e) =>
                          field.onChange(Number(e.target.value) * 1000)
                        }
                      />
                    )}
                  />
                </Stack>
              </Stack>
            ))}

          <Controller
            control={control}
            name="midRoll.breakLengthGridMs"
            render={({ field }) => (
              <FormControl fullWidth>
                <InputLabel>
                  <Trans>Break length step</Trans>
                </InputLabel>
                <Select
                  label={t`Break length step`}
                  value={field.value ?? 15_000}
                  onChange={(e) => field.onChange(Number(e.target.value))}
                >
                  {breakLengthGridOptions.map((seconds) => (
                    <MenuItem key={seconds} value={seconds * 1000}>
                      {seconds} s
                    </MenuItem>
                  ))}
                </Select>
                <FormHelperText>
                  <Trans>Planned break lengths are multiples of this</Trans>
                </FormHelperText>
              </FormControl>
            )}
          />
        </Stack>
      )}
    </Stack>
  );
};
