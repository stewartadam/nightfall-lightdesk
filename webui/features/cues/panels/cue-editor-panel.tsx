// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, onMount } from "solid-js";
import { getLogger } from "../../../lib/logger";
import { usePanelLiveness } from "../../../lib/panel-liveness";
import {
  CueEditorContextProvider,
  createCueEditorContextValue,
} from "../context/cue-editor-context";
import { CueEditorController } from "../controllers/cue-editor-controller";
import type { CueEditorPanelProps } from "../model/cue-editor-model";

const log = getLogger(import.meta.url);

/** Provides the cue editor context and composes its feature controller. */
export default function CueEditorPanel(props: CueEditorPanelProps) {
  const panelId = props.initialPanelId ?? props.id;

  /** Logs outer panel mounting for targeted diagnostics. */
  onMount(() => {
    log.trace("mounting CueEditorPanel");
  });

  const contextValue = createCueEditorContextValue(props.initialCueUid, {
    initialPartId: props.initialPartId ?? 0,
    initialSequenceId: props.initialSequenceId,
    initialSequenceUid: props.initialSequenceUid,
    closeOnSequenceDelete: props.closeOnSequenceDelete,
    setupSequenceUid: props.initialSetupSequenceUid,
    releaseSequenceUid: props.initialReleaseSequenceUid,
  });
  usePanelLiveness({
    panelId,
    closeWhenDead: true,
    isAlive: () => contextValue.loadingState().status !== "not_found",
  });

  /** Keeps the Dockview tab title aligned with loaded cue and sequence data. */
  createEffect(() => {
    const currentLabel = contextValue.label();
    if (currentLabel === "Cue Loading..." || currentLabel === "Cue Not Found") {
      return;
    }
    (
      props.panelApi as { setTitle?: (title: string) => void } | undefined
    )?.setTitle?.(currentLabel);
  });

  return (
    <CueEditorContextProvider value={contextValue}>
      <CueEditorController panelId={panelId} contextValue={contextValue} />
    </CueEditorContextProvider>
  );
}
