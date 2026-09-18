// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import { engineRuntime } from "../../../lib/engine-runtime";
import {
  decideSelectionFlattenConfirmation,
  pushToast,
  selectionFlattenConfirmation,
} from "../../../state/appStores";

/** Prompts before resubmitting a programmer command that explicitly permits flattening. */
export default function SelectionFlattenConfirmModal() {
  const pendingConfirmation = useStore(selectionFlattenConfirmation);

  /** Cancels the local retry workflow without sending another backend command. */
  const handleCancel = () => {
    decideSelectionFlattenConfirmation(false);
  };

  /** Approves either the awaited retry or a new fire-and-forget submission. */
  const handleConfirm = () => {
    const confirmation = decideSelectionFlattenConfirmation(true);
    if (!confirmation) {
      return;
    }

    const responseCorrelationId = engineRuntime.resubmitAfterConfirmation(
      confirmation.retry,
      confirmation.correlationId,
    );
    if (!responseCorrelationId) {
      pushToast("error", "Failed to resubmit command: disconnected");
    }
  };

  return (
    <DeleteConfirmModal
      isOpen={pendingConfirmation() !== null}
      title="Confirm Selection Flatten"
      message="This command may flatten programmer selection expressions. Continue?"
      confirmLabel="Continue"
      onCancel={handleCancel}
      onConfirm={handleConfirm}
    />
  );
}
