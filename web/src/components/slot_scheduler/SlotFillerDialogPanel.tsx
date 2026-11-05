import { Trans, useLingui } from '@lingui/react/macro';
import {
  Add,
  Delete,
  FirstPage,
  LastPage,
  LowPriority,
  Repeat,
  VerticalAlignCenter,
} from '@mui/icons-material';
import {
  Autocomplete,
  Button,
  Divider,
  FormControl,
  FormHelperText,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import { seq } from '@tunarr/shared/util';
import type { BaseSlot } from '@tunarr/types/api';
import { slotHasFiller } from '@tunarr/types/api';
import { find, map, some } from 'lodash-es';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Controller, useFieldArray, useFormContext } from 'react-hook-form';
import { slotOrderOptions } from '../../helpers/slotSchedulerUtil.ts';
import { useFillerLists } from '../../hooks/useFillerLists.ts';

type SlotFillerDialogPanelProps = {
  /**
   * Which entries this panel owns. Without it, the panel shows every entry and
   * every type, as random slots use it. Time slots show a Bumpers panel and an
   * Ads panel.
   */
  kind?: 'bumper' | 'ad';
};

// Bumpers are single clips around a program; ads are breaks of several clips.
// Mid is always an ad. Fallback is a last resort, so only a bumper.
const bumperTypes = ['head', 'pre', 'post', 'tail', 'fallback'] as const;
const adTypes = ['head', 'pre', 'mid', 'post', 'tail'] as const;

export const SlotFillerDialogPanel = ({
  kind,
}: SlotFillerDialogPanelProps = {}) => {
  const { t } = useLingui();
  // Whether an entry belongs to this panel.
  const ownsEntry = useCallback(
    (entryKind: 'bumper' | 'ad' | undefined) =>
      kind === undefined || (entryKind ?? 'bumper') === kind,
    [kind],
  );
  const allowedTypes: readonly string[] | undefined =
    kind === 'bumper' ? bumperTypes : kind === 'ad' ? adTypes : undefined;
  // A type this panel does not offer is hidden, not removed from the entry.
  const showType = (type: string) =>
    allowedTypes === undefined || allowedTypes.includes(type)
      ? undefined
      : { display: 'none' };
  const { control, getValues, watch } = useFormContext<BaseSlot>();
  const fillerFields = useFieldArray({ control, name: 'filler' });
  const { data: fillerLists } = useFillerLists();

  // Seed from the form so the already-chosen lists are known before the
  // watcher below fires for the first time.
  const [chosenFillerLists, setChosenFillerLists] = useState<string[]>(() => {
    const slot = getValues();
    return slotHasFiller(slot)
      ? seq.collect(slot.filler, (filler) =>
          filler && ownsEntry(filler.kind) ? filler.fillerListId : undefined,
        )
      : [];
  });

  // Insanely stupid hack we have to do in order to re-render on nested value
  // set.
  useEffect(() => {
    const { unsubscribe } = watch((value, info) => {
      if (
        value.type &&
        (value.type === 'custom-show' ||
          value.type === 'show' ||
          value.type === 'smart-collection') &&
        info.name?.startsWith('filler')
      ) {
        const fillerListIds = seq.collect(value.filler, (filler) =>
          filler && ownsEntry(filler.kind) ? filler.fillerListId : undefined,
        );
        setChosenFillerLists(fillerListIds);
      }
    });
    return () => unsubscribe();
  }, [watch, ownsEntry]);

  const fillerListOptions = useMemo(() => {
    if (chosenFillerLists.length <= 1) {
      return fillerLists;
    }

    return fillerLists.filter(
      (list) => !some(chosenFillerLists, (field) => field === list.id),
    );
  }, [chosenFillerLists, fillerLists]);

  // An empty filler list would never contribute anything to the slot, so it
  // isn't a candidate for a new row.
  const nextAddableFillerList = useMemo(
    () =>
      fillerLists.find(
        (list) =>
          list.contentCount > 0 &&
          !some(chosenFillerLists, (field) => field === list.id),
      ),
    [fillerLists, chosenFillerLists],
  );

  const handleAddNewFillerList = useCallback(() => {
    if (!nextAddableFillerList) {
      return;
    }

    fillerFields.append({
      types: kind === 'ad' ? ['mid'] : ['pre'],
      fillerListId: nextAddableFillerList.id,
      fillerOrder: 'shuffle_prefer_short',
      ...(kind ? { kind } : {}),
    });
  }, [fillerFields, nextAddableFillerList, kind]);

  if (fillerLists.length === 0) {
    return null;
  }

  return (
    <Stack spacing={2}>
      <Button
        startIcon={<Add />}
        variant="outlined"
        disabled={!nextAddableFillerList}
        onClick={handleAddNewFillerList}
      >
        {kind === 'ad' ? (
          <Trans>Add ads</Trans>
        ) : kind === 'bumper' ? (
          <Trans>Add bumpers</Trans>
        ) : (
          <Trans>Add filler</Trans>
        )}
      </Button>
      {fillerFields.fields.map((fillerField, idx) =>
        !ownsEntry(fillerField.kind) ? null : (
          <>
            <Stack spacing={2}>
              <Stack spacing={2} direction={'row'}>
                <IconButton
                  onClick={() => fillerFields.remove(idx)}
                  disableRipple
                  sx={{ alignSelf: 'start', top: 2 }}
                >
                  <Delete />{' '}
                </IconButton>
                <Controller
                  control={control}
                  name={`filler.${idx}.fillerListId` as const}
                  rules={{ required: true }}
                  render={({ field }) => {
                    const selected = find(fillerLists, { id: field.value });
                    return (
                      <Autocomplete
                        fullWidth
                        disableClearable={true}
                        options={fillerListOptions}
                        getOptionKey={(list) => list.id}
                        getOptionLabel={(list) => list.name}
                        // An empty filler list can't contribute anything to the
                        // slot, so don't let one be picked.
                        getOptionDisabled={(list) => list.contentCount === 0}
                        value={selected}
                        onChange={(_, list) => field.onChange(list?.id)}
                        renderInput={(params) => (
                          <TextField
                            {...params}
                            fullWidth
                            label={t`Filler List`}
                            helperText={
                              selected && selected.contentCount === 0
                                ? t`This filler list has no programs and will be ignored.`
                                : ' '
                            }
                          />
                        )}
                      />
                    );
                  }}
                />
                <Controller
                  control={control}
                  name={`filler.${idx}.fillerOrder`}
                  render={({ field }) => {
                    const opts = slotOrderOptions('filler');
                    const helperText = find(opts, {
                      value: field.value,
                    })?.helperText;
                    return (
                      <FormControl fullWidth>
                        <InputLabel>Order</InputLabel>
                        <Select label="Order" {...field}>
                          {map(opts, ({ description, value }) => (
                            <MenuItem key={value} value={value}>
                              {description}
                            </MenuItem>
                          ))}
                        </Select>
                        {helperText && (
                          <FormHelperText>{helperText}</FormHelperText>
                        )}
                      </FormControl>
                    );
                  }}
                />
              </Stack>
              <Stack direction={'row'} sx={{ pl: 6 }}>
                <Controller
                  control={control}
                  name={`filler.${idx}.types`}
                  rules={{
                    validate: { nonempty: (v) => (v ?? []).length > 0 },
                  }}
                  render={({ field }) => (
                    <ToggleButtonGroup
                      key={fillerField.id}
                      value={field.value}
                      onChange={(_, formats) => field.onChange(formats)}
                      sx={{ width: '100%' }}
                    >
                      <ToggleButton value="head" sx={showType('head')}>
                        <FirstPage />
                        <Trans>Head</Trans>
                      </ToggleButton>
                      <ToggleButton value={'pre'} sx={showType('pre')}>
                        <LowPriority
                          sx={{
                            rotate: '180deg',
                            transform: 'scale(-1, 1)',
                            mr: 1,
                          }}
                        />{' '}
                        <Trans>Pre</Trans>
                      </ToggleButton>
                      <ToggleButton value="mid" sx={showType('mid')}>
                        <VerticalAlignCenter sx={{ mr: 1 }} />{' '}
                        <Trans>Mid</Trans>
                      </ToggleButton>
                      <ToggleButton value="post" sx={showType('post')}>
                        <LowPriority sx={{ mr: 1 }} /> <Trans>Post</Trans>
                      </ToggleButton>
                      <ToggleButton value="tail" sx={showType('tail')}>
                        <LastPage sx={{ mr: 1 }} /> <Trans>Tail</Trans>
                      </ToggleButton>
                      <ToggleButton value="fallback" sx={showType('fallback')}>
                        <Repeat /> <Trans>Fallback</Trans>
                      </ToggleButton>
                    </ToggleButtonGroup>
                  )}
                />
              </Stack>
            </Stack>
            {fillerFields.fields.some(
              (f, i) => i > idx && ownsEntry(f.kind),
            ) && <Divider />}
          </>
        ),
      )}
    </Stack>
  );
};
