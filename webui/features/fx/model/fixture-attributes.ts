// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

/**
 * Derive a unique ordered list of attribute names from a list of fixtures.
 *
 * The Attribute type in TypeShare is a discriminated union of shape
 * { type: "Intensity" } | { type: "Pan" } | { type: "Custom", data: { label } }
 * We convert each parameter metadata attribute into a string name. For
 * Custom attributes we use the provided label where available.
 */
export function getFixtureAttributes(fixtures: types.Fixture[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const fixture of fixtures) {
    for (const element of fixture.elements || []) {
      for (const param of element.parameters || []) {
        const attr = param.attribute;
        let name: string;
        if ((attr as any).type === "Custom") {
          // TypeShare represents custom as { type: 'Custom', data: { label } }
          name = (attr as any).data?.label ?? "Custom";
        } else {
          name = (attr as any).type as string;
        }
        if (!seen.has(name)) {
          seen.add(name);
          out.push(name);
        }
      }
    }
  }

  return out;
}

/**
 * Derives attributes from only the fixtures represented by concrete selection targets.
 *
 * Element targets intentionally include every attribute on their owning fixture because
 * the Step FX editor scopes attribute availability at the fixture level.
 */
export function getTargetFixtureAttributes(
  fixtures: types.Fixture[],
  targets: readonly types.FixtureRef[],
): string[] {
  const targetUids = new Set(
    targets.map((target) => normalizeFixtureUid(target.fixture_uid)),
  );
  return getFixtureAttributes(
    fixtures.filter((fixture) =>
      targetUids.has(normalizeFixtureUid(fixture.identifiers.uid)),
    ),
  );
}

/** Normalizes UUID spellings so compact and hyphenated fixture identities compare equally. */
function normalizeFixtureUid(uid: string): string {
  return uid.replace(/-/g, "").toLowerCase();
}
