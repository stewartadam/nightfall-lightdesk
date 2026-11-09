// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { LockOpenIcon } from "@squidlab/phosphor-solid/lock-open";
import { createMemo, For, Show } from "solid-js";
import { Button } from "../../../components/ui/visual-language/button";
import { formatDataGridNumber } from "../../../lib/datagrid";
import { commandClient } from "../../../lib/engine-commands";
import {
  parkedAttributeName,
  parkedParameterKeys,
} from "../../../lib/parked-parameters";
import { useSharedStore } from "../../../lib/use-shared-store";
import { fixtures, parkedParameters } from "../../../state/appStores";
import type * as types from "../../../types";

type ParkedParametersSectionProps = {
  /**
   * Fixtures the section works on. When set, it lists only their parked parameters and offers
   * to park or unpark them; when unset, it lists every parked parameter in the show.
   */
  selectedFixtureUids?: readonly string[];
};

/** Sends one park command without waiting; failures and notices reach the operator as toasts. */
function sendParkCommand(command: types.ParkCommand): void {
  commandClient.emit("ParkCommand", command);
}

/**
 * Properties section listing parked parameters with actions to park, unpark one parameter, or
 * unpark everything in scope. Parked parameters hold their value over all playback, so the
 * section keeps them visible wherever fixtures are inspected.
 */
export function ParkedParametersSection(props: ParkedParametersSectionProps) {
  const $parked = useStore(parkedParameters);
  const $fixtures = useSharedStore(fixtures);

  /** Parked entries in scope: the selected fixtures' entries, or every entry. */
  const entries = createMemo(() => {
    const selected = props.selectedFixtureUids;
    if (selected === undefined) return $parked();
    const uids = new Set(selected);
    return $parked().filter((entry) => uids.has(entry.element.fixture_uid));
  });

  /**
   * Labels one parked entry as fixture ID, element (when the fixture has several) and attribute.
   * A deleted fixture stays parked until unparked, so undoing the delete restores it parked.
   */
  const entryLabel = (entry: types.ParkedParameter): string => {
    const fixture = $fixtures()[entry.element.fixture_uid];
    const fixtureId = fixture
      ? String(fixture.identifiers.id)
      : "Deleted fixture";
    const element =
      (fixture?.elements.length ?? 1) > 1 ? `.${entry.element.index ?? 1}` : "";
    return `${fixtureId}${element} ${parkedAttributeName(entry.attribute)}`;
  };

  /** Returns whether any fixture is selected, which park and unpark of the selection need. */
  const hasSelection = () => (props.selectedFixtureUids?.length ?? 0) > 0;

  return (
    <div class="space-y-2" data-testid="parked-parameters-section">
      <h3 class="text-xs uppercase tracking-wider text-neutral-400">Parked</h3>
      <div class="flex flex-wrap gap-2">
        <Show when={props.selectedFixtureUids !== undefined}>
          <Button
            size="compact"
            disabled={!hasSelection()}
            tooltip="Hold every parameter of the selected fixtures at its current output"
            onClick={() =>
              sendParkCommand({ type: "Park", data: { attributes: [] } })
            }
          >
            Park selection
          </Button>
          <Button
            size="compact"
            disabled={entries().length === 0}
            onClick={() =>
              sendParkCommand({ type: "Unpark", data: { attributes: [] } })
            }
          >
            Unpark selection
          </Button>
        </Show>
        <Show when={props.selectedFixtureUids === undefined}>
          <Button
            size="compact"
            disabled={entries().length === 0}
            onClick={() => sendParkCommand({ type: "UnparkAll" })}
          >
            Unpark all
          </Button>
        </Show>
      </div>
      <Show
        when={entries().length > 0}
        fallback={
          <div class="text-sm text-neutral-400">
            {props.selectedFixtureUids === undefined
              ? "Nothing is parked."
              : "Nothing in the selection is parked."}
          </div>
        }
      >
        <ul class="space-y-1 text-sm">
          <For each={entries()}>
            {(entry) => (
              <li class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate">{entryLabel(entry)}</span>
                <span class="tabular-nums text-orange-200">
                  {formatDataGridNumber(entry.value, false)}
                </span>
                <Button
                  size="icon-inline"
                  variant="subtle"
                  aria-label={`Unpark ${entryLabel(entry)}`}
                  tooltip={`Unpark ${entryLabel(entry)}`}
                  onClick={() =>
                    sendParkCommand({
                      type: "UnparkParameters",
                      data: parkedParameterKeys([entry]),
                    })
                  }
                >
                  <LockOpenIcon class="size-3.5" aria-hidden="true" />
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
