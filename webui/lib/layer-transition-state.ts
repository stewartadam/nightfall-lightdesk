// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { normalizeAttributeName } from "./utils";

export function layerHasTransitioningAttribute(
  rows: types.OutboundElementTransitionState[] | undefined,
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
): boolean {
  if (!rows) {
    return false;
  }

  const fixtureRow = rows.find((row) => row.fixture_uid === fixtureUid);
  if (!fixtureRow) {
    return false;
  }

  if (elementIndex !== undefined) {
    const elementParams = fixtureRow.parameters[elementIndex - 1];
    if (!elementParams) {
      return false;
    }
    return Object.entries(elementParams).some(
      ([key, value]) =>
        value === true && normalizeAttributeName(key) === attribute,
    );
  }

  return fixtureRow.parameters.some((elementParams) =>
    Object.entries(elementParams).some(
      ([key, value]) =>
        value === true && normalizeAttributeName(key) === attribute,
    ),
  );
}

export function anyLayerHasTransitioningAttribute(
  layers: readonly types.OutboundLayerState[],
  fixtureUid: string,
  elementIndex: number | undefined,
  attribute: string,
  layerFilter?: (layer: types.OutboundLayerState) => boolean,
): boolean {
  return layers.some(
    (layer) =>
      (layerFilter ? layerFilter(layer) : true) &&
      layerHasTransitioningAttribute(
        layer.computed_transitioning,
        fixtureUid,
        elementIndex,
        attribute,
      ),
  );
}
