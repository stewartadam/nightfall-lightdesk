// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { debounce } from "@solid-primitives/scheduled";
import { ArrowCounterClockwiseIcon } from "@squidlab/phosphor-solid/arrow-counter-clockwise";
import {
  createEffect,
  createMemo,
  createSignal,
  Index,
  on,
  Show,
} from "solid-js";
import { EmptyState } from "../../../components/ui/empty-state";
import { NumericStepper } from "../../../components/ui/numeric-stepper";
import { Button } from "../../../components/ui/visual-language/button";
import { commandClient } from "../../../lib/engine-commands";
import { useSharedStore } from "../../../lib/use-shared-store";
import { fixtures } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  fixtureOutputOffsetRows,
  type OutputOffsetRow,
  outputOffsetCommand,
} from "../model/output-offsets";

/** Delay before a typed offset is sent, so each keystroke doesn't add an undo step. */
const OFFSET_COMMIT_DELAY_MS = 400;
/** Largest offset either way, as a percentage of the parameter's range. */
const MAX_OFFSET_PERCENT = 100;

type OutputOffsetsPropertiesProps = {
  /** Fixture IDs selected in the Patch fixture list. */
  selectedFixtureIds: readonly number[];
};

type OutputOffsetFieldProps = {
  fixtureId: number;
  row: OutputOffsetRow;
};

/** Sends one offset change; failures reach the operator as toasts. */
function sendOffset(
  fixtureId: number,
  attribute: types.Attribute,
  percent: number,
): void {
  commandClient.emit(
    "FixtureCommand",
    outputOffsetCommand(fixtureId, attribute, percent),
  );
}

/**
 * Edits one attribute's offset in percent. Typing sends after a pause, Enter or leaving the field
 * sends at once, and the field follows the engine's value whenever no edit is pending.
 */
function OutputOffsetField(props: OutputOffsetFieldProps) {
  const [draft, setDraft] = createSignal(String(props.row.percent));
  /** Fixture and attribute the pending edit was typed for, so a late send can't change another. */
  let pending: { fixtureId: number; row: OutputOffsetRow } | undefined;

  /** Shows the engine's value when it changes, unless the operator is mid-edit. */
  createEffect(
    on(
      () => props.row.percent,
      (percent) => {
        if (!pending) setDraft(String(percent));
      },
    ),
  );

  /** Sends the drafted offset if it is a valid number within range. */
  const commit = () => {
    schedule.clear();
    const target = pending;
    if (!target) return;
    pending = undefined;
    const value = Number(draft());
    if (
      draft().trim() === "" ||
      !Number.isFinite(value) ||
      Math.abs(value) > MAX_OFFSET_PERCENT
    ) {
      setDraft(String(props.row.percent));
      return;
    }
    if (value !== target.row.percent) {
      sendOffset(target.fixtureId, target.row.attribute, value);
    }
  };
  const schedule = debounce(commit, OFFSET_COMMIT_DELAY_MS);

  return (
    <li
      class="flex items-center gap-2"
      data-testid="output-offset-row"
      data-attribute={props.row.label}
    >
      <span
        class="min-w-0 flex-1 truncate"
        classList={{ "text-orange-200": props.row.percent !== 0 }}
      >
        {props.row.label}
      </span>
      <NumericStepper
        class="w-36"
        density="compact"
        aria-label={`${props.row.label} offset in percent`}
        min={-MAX_OFFSET_PERCENT}
        max={MAX_OFFSET_PERCENT}
        step="any"
        stepBy={1}
        unit="%"
        value={draft()}
        onValueChange={(value) => {
          setDraft(value);
          pending ??= { fixtureId: props.fixtureId, row: props.row };
          schedule();
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
        decreaseLabel={`Decrease ${props.row.label} offset`}
        increaseLabel={`Increase ${props.row.label} offset`}
      />
      <Button
        size="icon-inline"
        variant="subtle"
        disabled={props.row.percent === 0}
        aria-label={`Reset ${props.row.label} offset`}
        tooltip={`Reset ${props.row.label} offset`}
        onClick={() => {
          schedule.clear();
          pending = undefined;
          setDraft("0");
          sendOffset(props.fixtureId, props.row.attribute, 0);
        }}
      >
        <ArrowCounterClockwiseIcon class="size-3.5" aria-hidden="true" />
      </Button>
    </li>
  );
}

/**
 * Properties section that edits a patched fixture's output offsets: a fixed shift, in percent of
 * each parameter's range, applied to everything the fixture outputs. Use it to line up a mover
 * that is mounted a little off, or to match a fixture's color to its neighbors.
 */
export default function OutputOffsetsProperties(
  props: OutputOffsetsPropertiesProps,
) {
  const $fixtures = useSharedStore(fixtures);

  /** The one selected fixture, since offsets are edited a fixture at a time. */
  const fixture = createMemo(() => {
    if (props.selectedFixtureIds.length !== 1) return undefined;
    const id = props.selectedFixtureIds[0];
    return Object.values($fixtures()).find(
      (candidate) => candidate.identifiers.id === id,
    );
  });

  /** ID of the selected fixture; the editor remounts when it changes so drafts never carry over. */
  const fixtureId = createMemo(() => fixture()?.identifiers.id);

  /** Offset rows of the selected fixture, rebuilt when its profile or offsets change. */
  const rows = createMemo(() => {
    const selected = fixture();
    return selected ? fixtureOutputOffsetRows(selected) : [];
  });

  return (
    <div class="space-y-2 p-4" data-testid="output-offsets-properties">
      <h3 class="text-xs uppercase tracking-wider text-neutral-400">
        Output offsets
      </h3>
      <Show
        when={fixtureId()}
        keyed
        fallback={
          <EmptyState
            variant="inline"
            title="Select one fixture to edit its output offsets."
          />
        }
      >
        {(selectedId) => (
          <>
            <p class="text-xs text-neutral-400">
              Shifts what fixture {selectedId} outputs, in percent of each
              parameter's range.
            </p>
            <ul class="space-y-1 text-sm">
              <Index each={rows()}>
                {(row) => (
                  <OutputOffsetField fixtureId={selectedId} row={row()} />
                )}
              </Index>
            </ul>
          </>
        )}
      </Show>
    </div>
  );
}
