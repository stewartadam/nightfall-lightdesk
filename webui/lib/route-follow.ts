// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

type RowWithRouteId = {
  rowKind: string;
  route?: {
    id: string;
  };
};

export function getRouteIdForAltFollow<Row extends RowWithRouteId>(
  row: Row | undefined,
  altKeyPressed: boolean,
): string | null {
  if (row?.rowKind !== "route" || !altKeyPressed) {
    return null;
  }

  const routeId = row.route?.id;
  if (!routeId) {
    return null;
  }

  return routeId;
}
