// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, onCleanup } from "solid-js";
import { reducedMotion } from "../../../state/reduced-motion";
import type { StepFxTrackKind } from "../model/step-fx-editor-model";
import type { StepFxEditorSelectionController } from "./step-fx-editor-selection-controller";

const CONTRIBUTION_SLIDE_DURATION_MS = 140;

/** Lifecycle phase of the horizontal absolute/relative contribution transition. */
export type StepFxContributionSlidePhase = "idle" | "outgoing" | "incoming";

/**
 * Animates switches between a lane's absolute and relative contributions,
 * committing the track selection between the outgoing and incoming slides.
 */
export function createStepFxContributionSlideController(
  selection: StepFxEditorSelectionController,
) {
  const [pendingContributionTrack, setPendingContributionTrack] =
    createSignal<StepFxTrackKind>();
  const [contributionSlidePhase, setContributionSlidePhase] =
    createSignal<StepFxContributionSlidePhase>("idle");
  const [contributionSlideDirection, setContributionSlideDirection] =
    createSignal<"left" | "right">();
  let contributionPanelElement: HTMLDivElement | undefined;
  let contributionSlideAnimation: Animation | undefined;
  let contributionSlideToken = 0;

  /** Records the animated contribution panel element rendered by the track stage. */
  const setContributionPanelElement = (element: HTMLDivElement): void => {
    contributionPanelElement = element;
  };

  /** Slides the active contribution out and its horizontal neighbor into view. */
  const selectContributionTrack = (kind: StepFxTrackKind): void => {
    if (
      kind === selection.trackKind() ||
      pendingContributionTrack() !== undefined ||
      !contributionPanelElement
    )
      return;
    if (reducedMotion.get()) {
      selection.selectTrack(selection.selectedLane(), kind);
      return;
    }

    const direction = kind === "relative" ? "right" : "left";
    const outgoingX = direction === "right" ? "-100%" : "100%";
    const incomingX = direction === "right" ? "100%" : "-100%";
    const token = ++contributionSlideToken;
    setPendingContributionTrack(kind);
    setContributionSlideDirection(direction);
    setContributionSlidePhase("outgoing");
    const outgoing = contributionPanelElement.animate(
      [
        { transform: "translateX(0)" },
        { transform: `translateX(${outgoingX})` },
      ],
      {
        duration: CONTRIBUTION_SLIDE_DURATION_MS,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        fill: "forwards",
      },
    );
    contributionSlideAnimation = outgoing;

    void outgoing.finished
      .then(() => {
        if (token !== contributionSlideToken || !contributionPanelElement)
          return undefined;
        outgoing.cancel();
        selection.selectTrack(selection.selectedLane(), kind);
        setContributionSlidePhase("incoming");
        const incoming = contributionPanelElement.animate(
          [
            { transform: `translateX(${incomingX})` },
            { transform: "translateX(0)" },
          ],
          {
            duration: CONTRIBUTION_SLIDE_DURATION_MS,
            easing: "cubic-bezier(0, 0, 0.2, 1)",
          },
        );
        contributionSlideAnimation = incoming;
        return incoming.finished;
      })
      // A cancelled animation rejects; settle anyway so later track switches are not blocked.
      .catch(() => undefined)
      .then(() => {
        if (token !== contributionSlideToken) return;
        contributionSlideAnimation = undefined;
        setPendingContributionTrack(undefined);
        setContributionSlidePhase("idle");
      });
  };

  onCleanup(() => {
    contributionSlideToken += 1;
    contributionSlideAnimation?.cancel();
    contributionSlideAnimation = undefined;
  });

  return {
    pendingContributionTrack,
    contributionSlidePhase,
    contributionSlideDirection,
    setContributionPanelElement,
    selectContributionTrack,
  };
}
