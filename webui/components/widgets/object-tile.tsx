// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CheckIcon } from "@squidlab/phosphor-solid/check";
import { SquaresFourIcon } from "@squidlab/phosphor-solid/squares-four";
import { For, type JSX, Show } from "solid-js";
import { Button } from "../ui/visual-language/button";

export interface ObjectTileProps {
  identity: string;
  title: string;
  detail: string;
  tags?: readonly string[];
  selected: boolean;
  onSelect: () => void;
  onContextMenu?: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  onKeyDown?: JSX.EventHandler<HTMLButtonElement, KeyboardEvent>;
}

/** Presents a compact object summary with full names and metadata available on hover. */
export function ObjectTile(props: ObjectTileProps) {
  return (
    <Button
      class="object-tile"
      classList={{ selected: props.selected }}
      aria-pressed={props.selected}
      title={[
        props.identity,
        props.title,
        props.detail,
        ...(props.tags ?? []),
      ].join("\n")}
      onClick={props.onSelect}
      onContextMenu={props.onContextMenu}
      onKeyDown={props.onKeyDown}
    >
      <span class="tile-top">
        <span class="tile-id">{props.identity}</span>
        <span class="selection-mark">
          <Show when={props.selected} fallback={<SquaresFourIcon size={17} />}>
            <CheckIcon size={16} weight="bold" />
          </Show>
        </span>
      </span>
      <span class="tile-name">{props.title}</span>
      <span class="tile-detail">{props.detail}</span>
      <Show when={props.tags?.length}>
        <span class="tile-tags">
          <For each={props.tags}>
            {(tag) => <span class="tile-tag">{tag}</span>}
          </For>
        </span>
      </Show>
    </Button>
  );
}
