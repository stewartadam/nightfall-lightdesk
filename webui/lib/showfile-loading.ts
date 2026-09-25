// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import type * as types from "../types";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

const CURRENT_SHOWFILE_STORAGE_KEY = "nightfall.currentShowfileName";

/**
 * Reads the persisted showfile name without subscribing to browser storage.
 */
function storedCurrentShowfileName(): string {
  try {
    return normalizedShowfileName(
      localStorage.getItem(CURRENT_SHOWFILE_STORAGE_KEY),
    );
  } catch (error) {
    log.warn("failed to read current showfile name", error);
    return "default";
  }
}

/** Current showfile name remembered by this frontend origin. */
export const currentShowfileName = atom<string>(storedCurrentShowfileName());
/** Monotonic counter for backend-confirmed current showfile context changes. */
export const currentShowfileRevision = atom<number>(0);
let lastConfirmedShowfileChangeId: string | null = null;

/** Applies confirmed identity once per change, preserving layouts during resync replays. */
export function applyConfirmedShowfileChange(
  name: string | null | undefined,
  changeId: string,
): void {
  const changed = lastConfirmedShowfileChangeId !== changeId;
  lastConfirmedShowfileChangeId = changeId;
  persistCurrentShowfileName(name);
  if (changed) {
    currentShowfileRevision.set(currentShowfileRevision.get() + 1);
  }
}

/**
 * Normalizes the default showfile name for browser-side persistence and matching.
 */
export function normalizedShowfileName(
  name: string | null | undefined,
): string {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" || trimmed === "default" ? "default" : trimmed;
}

/**
 * Stores the showfile name that this browser last asked the backend to load.
 */
export function persistCurrentShowfileName(
  name: string | null | undefined,
): void {
  const showfileName = normalizedShowfileName(name);
  currentShowfileName.set(showfileName);
  try {
    localStorage.setItem(CURRENT_SHOWFILE_STORAGE_KEY, showfileName);
  } catch (error) {
    log.warn("failed to persist current showfile name", error);
  }
}

/**
 * Reads the showfile name expected to be loaded when the frontend starts.
 */
export function expectedStartupShowfileName(): string {
  return storedCurrentShowfileName();
}

/**
 * Builds the desk command that loads the requested showfile name.
 */
export function showfileLoadCommandForName(name: string): {
  command: types.DeskCommand;
  showfileName: string;
} {
  const showfileName = normalizedShowfileName(name);
  if (showfileName === "default") {
    return {
      command: { type: "LoadShowfile" },
      showfileName,
    };
  }

  return {
    command: { type: "LoadNamedShowfile", data: showfileName },
    showfileName,
  };
}
