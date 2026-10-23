// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import "../../ui/selectable-surface.css";

/** Card layout class; pair it with `data-selectable-surface` and `data-selected` for state styling. */
export const CRUD_CARD_CLASS = "nf-crud-card text-left";

/**
 * Square icon tag on a card header (such as a type or wrap marker), sized to
 * match an `icon-inline` button so tags and card actions line up.
 */
export const CRUD_CARD_ICON_CLASS =
  "inline-flex size-5.5 shrink-0 items-center justify-center rounded-md";

export const CRUD_GRID_DRAG_BOX_CLASS =
  "pointer-events-none absolute z-20 rounded border border-blue-400/80 bg-blue-400/15";
