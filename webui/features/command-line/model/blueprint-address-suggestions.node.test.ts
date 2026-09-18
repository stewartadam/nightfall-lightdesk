// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CommandAutocompleteObjectReferenceRequest } from "../../../lib/wasm-bridge";
import type { Blueprint } from "../../../types";
import { blueprintAddressSuggestions } from "./blueprint-address-suggestions";

/** Builds a minimal Blueprint address candidate. */
function blueprint(id: number, label: string): Blueprint {
  return {
    identifiers: { id, uid: `blueprint-${id}`, label },
  } as unknown as Blueprint;
}

/** Supplies an address slot and edit template exactly as the parser contract requires. */
function addressRequest(
  query = "",
  start = 11,
): CommandAutocompleteObjectReferenceRequest {
  return {
    id: "object-reference-1",
    object_kind: "blueprint",
    slot: {
      slot: "recall_blueprint_identifier",
      clause: { clause: "recall_blueprint", instance: 0 },
    },
    frontier_sources: [0],
    replace: { start, end: start + query.length },
    query,
    before_value: "",
    after_value: " ",
  };
}

/** Blueprint address slots offer inventory IDs and safely quoted labels. */
test("completes Blueprint IDs and labels", () => {
  const suggestions = blueprintAddressSuggestions([addressRequest()], {
    first: blueprint(5, "Warm White"),
  });
  assert.deepEqual(
    suggestions.map((suggestion) =>
      suggestion.kind === "token" ? suggestion.insertText : suggestion.label,
    ),
    ["5", '"Warm White"'],
  );
});

/** Label prefixes filter candidates in complete-application and recall forms. */
test("filters Blueprint address labels", () => {
  const suggestions = blueprintAddressSuggestions(
    [addressRequest("warm", 17)],
    {
      warm: blueprint(5, "Warm White"),
      cool: blueprint(6, "Cool White"),
    },
  );
  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.label),
    ["Warm White"],
  );
});

/** Runtime inventories cannot offer values without an explicit grammar request. */
test("does not infer Blueprint grammar from runtime data", () => {
  assert.deepEqual(
    blueprintAddressSuggestions([], { warm: blueprint(5, "Warm White") }),
    [],
  );
});

/** Runtime labels preserve the parser's spacing and replacement range. */
test("uses the parser edit template for quoted labels", () => {
  const request = { ...addressRequest(), before_value: " ", after_value: " " };
  const suggestions = blueprintAddressSuggestions([request], {
    named: blueprint(5, 'Warm "White"'),
  });
  assert.equal(
    suggestions[1].kind === "token" && suggestions[1].applyText,
    String.raw` "Warm \"White\"" `,
  );
  assert.deepEqual(suggestions[1].replace, request.replace);
});
