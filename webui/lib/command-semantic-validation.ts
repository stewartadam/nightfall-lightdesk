// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import {
  isReservedOutputTargetKeyword,
  networkDmxOutputsFromSettings,
  reservedOutputTargetKeywordsReady,
  usbDmxOutputsFromSettings,
} from "./network-dmx-output-targets";
import { splitCommandStatements } from "./wasm-bridge";

export type CommandSemanticValidationResult =
  | { status: "ok" }
  | { status: "error"; message: string };

/**
 * Validates command semantics that depend on browser-side desk state.
 */
export async function validateCommandSemantics(
  command: string,
  settings: types.IoRuntimeSettings,
): Promise<CommandSemanticValidationResult> {
  if (!reservedOutputTargetKeywordsReady()) {
    return { status: "ok" };
  }

  const knownTargets = outputTargetIds(settings);

  const statements = await splitCommandStatements(command);
  if (!statements) {
    return { status: "ok" };
  }

  for (const statement of statements) {
    const targetName = patchTargetName(statement);
    if (!targetName) {
      continue;
    }

    const normalizedTarget = normalizePatchTargetName(targetName);

    if (
      !knownTargets.has(normalizedTarget) &&
      !isReservedOutputTargetKeyword(normalizedTarget)
    ) {
      return {
        status: "error",
        message: `Unknown output transport target "${targetName}". Configure it in I/O Transports before patching to it.`,
      };
    }
  }

  return { status: "ok" };
}

/**
 * Builds the set of configured output target IDs accepted by patch output commands.
 */
function outputTargetIds(settings: types.IoRuntimeSettings): Set<string> {
  return new Set(
    [
      ...networkDmxOutputsFromSettings(settings).targets,
      ...usbDmxOutputsFromSettings(settings).targets,
    ].map((target) => normalizePatchTargetName(target.id)),
  );
}

/**
 * Extracts the target-side endpoint name from patch commands.
 */
function patchTargetName(statement: string): string | null {
  const trimmed = statement.trim();
  if (!/^(?:rm\s+)?patch\b/i.test(trimmed)) {
    return null;
  }

  const targetMarkerIndex = trimmed.lastIndexOf("@");
  if (targetMarkerIndex < 0) {
    return null;
  }

  const targetSegment = trimmed.slice(targetMarkerIndex + 1).trimStart();
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)/.exec(targetSegment);
  return match?.[1] ?? null;
}

/**
 * Normalizes command target spelling before comparing it with configured IDs.
 */
function normalizePatchTargetName(targetName: string): string {
  return targetName.toLowerCase();
}
