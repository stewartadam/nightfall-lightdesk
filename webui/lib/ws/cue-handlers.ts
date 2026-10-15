// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  cueDefinitionsLoaded,
  cueDurationProfiles,
  cues,
  masters,
  sequenceDefinitionsLoaded,
  sequenceLookaheadStates,
  sequences,
} from "../../state/appStores";
import type * as types from "../../types";
import { getLogger } from "../logger";
import { setStoreAction, setStoreKeyAction } from "../nanostore-action";
import {
  arrayToUidMap,
  measureDispatchStep,
  normalizeBackendUid,
} from "./handler-utils";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

const log = getLogger(import.meta.url);

/** Registers cue, sequence, duration-profile, Lookahead, and master handlers. */
export function registerCueHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("CueDefinitions", (message) => {
    const cueList = message.data as types.Cue[];
    const cueMap = measureDispatchStep(
      message.type,
      "array-to-uid-map",
      () => arrayToUidMap(cueList),
      { itemCount: cueList.length },
    );
    measureDispatchStep(
      message.type,
      "store.cues.set",
      () => setStoreAction(cues, "Receive CueDefinitions", cueMap),
      { itemCount: cueList.length },
    );
    setStoreAction(cueDefinitionsLoaded, "Receive CueDefinitions", true);
  });

  registry.register("CueDefinitionUpdated", (message) => {
    const cue = message.data as types.Cue;
    setStoreKeyAction(
      cues,
      "Receive CueDefinitionUpdated",
      cue.identifiers.uid,
      cue,
    );
    setStoreAction(cueDefinitionsLoaded, "Receive CueDefinitionUpdated", true);
  });

  registry.register("CueDefinitionRemoved", (message) => {
    const removed = message.data as types.RemovedCueDefinition;
    const updated = measureDispatchStep(
      message.type,
      "clone-without-removed",
      () => {
        const next = { ...cues.get() };
        delete next[removed.uid];
        return next;
      },
      { uid: removed.uid },
    );
    measureDispatchStep(
      message.type,
      "store.cues.set",
      () => setStoreAction(cues, "Receive CueDefinitionRemoved", updated),
      { uid: removed.uid },
    );
  });

  registry.register("CueDurationProfiles", (message) => {
    const profiles = message.data as types.CueDurationProfileMessage[];
    const profileMap = measureDispatchStep(
      message.type,
      "array-to-profile-map",
      () => cueDurationProfileArrayToMap(profiles),
      { itemCount: profiles.length },
    );
    measureDispatchStep(
      message.type,
      "store.cue-duration-profiles.set",
      () =>
        setStoreAction(
          cueDurationProfiles,
          "Receive CueDurationProfiles",
          profileMap,
        ),
      { itemCount: profiles.length },
    );
  });

  registry.register("CueDurationProfileUpdated", (message) => {
    const profile = message.data as types.CueDurationProfileMessage;
    setStoreKeyAction(
      cueDurationProfiles,
      "Receive CueDurationProfileUpdated",
      profile.cue_uid,
      profile,
    );
  });

  registry.register("CueDurationProfileRemoved", (message) => {
    const removed = message.data as types.RemovedCueDefinition;
    const updated = measureDispatchStep(
      message.type,
      "clone-without-removed",
      () => {
        const next = { ...cueDurationProfiles.get() };
        delete next[removed.uid];
        return next;
      },
      { uid: removed.uid },
    );
    measureDispatchStep(
      message.type,
      "store.cue-duration-profiles.set",
      () =>
        setStoreAction(
          cueDurationProfiles,
          "Receive CueDurationProfileRemoved",
          updated,
        ),
      { uid: removed.uid },
    );
  });

  registry.register("SequenceLookaheadStates", (message) => {
    const rawStates = message.data as types.SequenceLookaheadStateMessage[];
    const states = measureDispatchStep(
      message.type,
      "normalize-states",
      () => rawStates.map(normalizeSequenceLookaheadState),
      { itemCount: rawStates.length },
    );
    const stateMap = measureDispatchStep(
      message.type,
      "array-to-state-map",
      () =>
        Object.fromEntries(states.map((state) => [state.sequence_uid, state])),
      { itemCount: states.length },
    );
    measureDispatchStep(
      message.type,
      "store.sequence-lookahead-states.set",
      () =>
        setStoreAction(
          sequenceLookaheadStates,
          "Receive SequenceLookaheadStates",
          stateMap,
        ),
      { itemCount: states.length },
    );
  });

  registry.register("SequenceDefinitions", (message) => {
    const sequenceList = message.data as types.Sequence[];
    const sequenceMap = measureDispatchStep(
      message.type,
      "array-to-uid-map",
      () => arrayToUidMap(sequenceList),
      { itemCount: sequenceList.length },
    );
    measureDispatchStep(
      message.type,
      "store.sequences.set",
      () =>
        setStoreAction(sequences, "Receive SequenceDefinitions", sequenceMap),
      { itemCount: sequenceList.length },
    );
    setStoreAction(
      sequenceDefinitionsLoaded,
      "Receive SequenceDefinitions",
      true,
    );
  });

  registry.register("SequenceDefinitionUpdated", (message) => {
    const sequence = message.data as types.Sequence;
    setStoreKeyAction(
      sequences,
      "Receive SequenceDefinitionUpdated",
      sequence.identifiers.uid,
      sequence,
    );
    setStoreAction(
      sequenceDefinitionsLoaded,
      "Receive SequenceDefinitionUpdated",
      true,
    );
  });

  registry.register("SequenceDefinitionRemoved", (message) => {
    const removed = message.data as types.RemovedSequenceDefinition;
    const updated = measureDispatchStep(
      message.type,
      "clone-without-removed",
      () => {
        const next = { ...sequences.get() };
        delete next[removed.uid];
        return next;
      },
      { uid: removed.uid },
    );
    measureDispatchStep(
      message.type,
      "store.sequences.set",
      () =>
        setStoreAction(sequences, "Receive SequenceDefinitionRemoved", updated),
      { uid: removed.uid },
    );
  });

  registry.register("MasterDefinitions", (message) => {
    setStoreAction(
      masters,
      "Receive MasterDefinitions",
      arrayToUidMap(message.data as types.Master[]),
    );
  });

  registry.register("CueCommand", (message) => {
    handleCueCommand(message.data as unknown as types.CueCommand);
  });
}

/** Indexes cue duration profile messages by cue UID. */
function cueDurationProfileArrayToMap(
  profiles: types.CueDurationProfileMessage[],
) {
  return Object.fromEntries(
    profiles.map((profile) => [profile.cue_uid, profile]),
  );
}

/** Normalizes backend-authored sequence Lookahead projection state for UI store lookups. */
function normalizeSequenceLookaheadState(
  state: types.SequenceLookaheadStateMessage,
): types.SequenceLookaheadStateMessage {
  return {
    ...state,
    sequence_uid: normalizeBackendUid(state.sequence_uid),
    rows: state.rows.map((row) => ({
      ...row,
      cue_uid: normalizeBackendUid(row.cue_uid),
    })),
  };
}

/**
 * Handles cue command echoes that arrive before the corresponding provider snapshot.
 *
 * Cue and sequence mutations are intentionally ignored here because committed
 * definition updates arrive through backend websocket messages.
 */
function handleCueCommand(command: types.CueCommand) {
  log.trace("Handling CueCommand:", command);

  // CRUD commands (StoreCue, RenameCue, DeleteCue, StoreSequence,
  // RenameSequence, DeleteSequence) are not processed here.
  // Instead, we receive CueDefinitionUpdated/CueDefinitionRemoved and
  // SequenceDefinitionUpdated/SequenceDefinitionRemoved messages, or full
  // snapshots during resync.
  // This prevents optimistic updates that show stale data when commands fail.
  log.trace(
    "Ignoring CueCommand (handled via CueDefinitions/SequenceDefinitions):",
    command.type,
  );
}
