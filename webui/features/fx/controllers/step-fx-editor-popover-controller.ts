// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";

/** Mutually exclusive toolbar menus owned by the Step FX editor. */
export type StepFxEditorPopover = "timing" | "start-position" | "overrides";

/**
 * Coordinates the editor's mutually exclusive popovers and the counter-based
 * focus and dismiss requests forwarded to child controls by shortcuts.
 */
export function createStepFxEditorPopoverController() {
  const [openPopover, setOpenPopover] = createSignal<StepFxEditorPopover>();
  const [attributeSearchFocusRequest, setAttributeSearchFocusRequest] =
    createSignal(0);
  const [attributePickerDismissRequest, setAttributePickerDismissRequest] =
    createSignal(0);
  const [advancedPhaseFocusRequest, setAdvancedPhaseFocusRequest] =
    createSignal(0);

  /** Makes one editor popover visible while dismissing any peer popover. */
  const setEditorPopoverOpen = (
    popover: StepFxEditorPopover,
    isOpen: boolean,
  ): void => {
    setOpenPopover((current) =>
      isOpen ? popover : current === popover ? undefined : current,
    );
  };

  /** Opens attribute search and selects its query for immediate replacement. */
  const focusAttributeSearch = (): void => {
    setOpenPopover(undefined);
    setAttributeSearchFocusRequest((request) => request + 1);
  };

  /** Opens the start-position popover and selects its advanced expression. */
  const focusAdvancedPhaseExpression = (): void => {
    setOpenPopover("start-position");
    setAdvancedPhaseFocusRequest((request) => request + 1);
  };

  /** Dismisses all editor popovers without changing authored values. */
  const dismissEditorPopovers = (): void => {
    setOpenPopover(undefined);
    setAttributePickerDismissRequest((request) => request + 1);
  };

  return {
    openPopover,
    setOpenPopover,
    setEditorPopoverOpen,
    attributeSearchFocusRequest,
    attributePickerDismissRequest,
    advancedPhaseFocusRequest,
    focusAttributeSearch,
    focusAdvancedPhaseExpression,
    dismissEditorPopovers,
  };
}
