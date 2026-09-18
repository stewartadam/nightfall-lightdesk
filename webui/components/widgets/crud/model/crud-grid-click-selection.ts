// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createSignal } from "solid-js";

const CARD_ID_ATTR = "data-crud-select-id";

interface CrudGridClickSelectionOptions {
  enabled: Accessor<boolean>;
  orderedIds: Accessor<readonly string[]>;
  selectedIds: Accessor<readonly string[]>;
  onSelectionChange: (ids: string[]) => void;
  multiSelectOnPlainClick?: boolean;
}

export function createCrudGridClickSelection(
  options: CrudGridClickSelectionOptions,
) {
  const [lastInteractedId, setLastInteractedId] = createSignal<string | null>(
    null,
  );

  const getRangeIds = (fromId: string, toId: string): string[] => {
    const orderedIds = options.orderedIds();
    const fromIndex = orderedIds.indexOf(fromId);
    const toIndex = orderedIds.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1) {
      return [];
    }
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    return orderedIds.slice(start, end + 1);
  };

  const handleCardClick = (id: string, event: MouseEvent): boolean => {
    if (!options.enabled()) return false;

    const current = new Set(options.selectedIds());
    let next: string[];

    if (event.shiftKey) {
      const anchor = lastInteractedId() ?? id;
      const range = getRangeIds(anchor, id);
      if (range.length === 0) {
        return true;
      }
      for (const rangeId of range) {
        current.add(rangeId);
      }
      next = Array.from(current);
    } else if (
      event.ctrlKey ||
      event.metaKey ||
      options.multiSelectOnPlainClick === true
    ) {
      if (current.has(id)) {
        current.delete(id);
      } else {
        current.add(id);
      }
      next = Array.from(current);
    } else {
      next = [id];
    }

    setLastInteractedId(id);
    options.onSelectionChange(next);
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const handleBackgroundClick = (event: MouseEvent): boolean => {
    if (!options.enabled()) return false;
    const target = event.target as Element | null;
    if (target?.closest(`[${CARD_ID_ATTR}]`)) return false;

    setLastInteractedId(null);
    options.onSelectionChange([]);
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  return {
    handleCardClick,
    handleBackgroundClick,
  };
}
