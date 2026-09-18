// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  DialogBackdrop,
  DialogBody,
  DialogCloseButton,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/form-controls";
import Modal from "../../../components/ui/modal";
import { Button } from "../../../components/ui/visual-language/button";
import ObjectSelector from "../../../components/widgets/object-selector";
import {
  type CueTargetOption,
  clampIdInput,
  type GroupTargetOption,
} from "../model/programmer-grid-model";

export type ProgrammerStoreDialogsProps = {
  showCue: boolean;
  showGroup: boolean;
  cueTargets: CueTargetOption[];
  groupTargets: GroupTargetOption[];
  cueSequenceId: number;
  cueId: number;
  cueLabel: string;
  groupId: number;
  groupLabel: string;
  setCueSequenceId: (value: number) => void;
  setCueId: (value: number) => void;
  setCueLabel: (value: string) => void;
  setCueLabelEdited: (value: boolean) => void;
  setGroupId: (value: number) => void;
  setGroupLabel: (value: string) => void;
  setGroupLabelEdited: (value: boolean) => void;
  closeCue: () => void;
  closeGroup: () => void;
  storeCue: (event: Event) => void;
  storeGroup: (event: Event) => void;
};

/** Renders the feature-owned cue and group storage dialogs. */
export function ProgrammerStoreDialogs(props: ProgrammerStoreDialogsProps) {
  return (
    <>
      <Modal isOpen={props.showCue} onEscape={props.closeCue}>
        <DialogBackdrop>
          <DialogSurface
            class="max-w-lg"
            role="dialog"
            aria-modal="true"
            aria-label="Store Cue"
          >
            <form onSubmit={props.storeCue}>
              <DialogHeader>
                <DialogTitle>Store Cue</DialogTitle>
                <DialogCloseButton type="button" onClick={props.closeCue} />
              </DialogHeader>

              <DialogBody class="space-y-4">
                <ObjectSelector
                  items={props.cueTargets}
                  selectedKey={`${props.cueSequenceId}.${props.cueId}`}
                  onSelect={(target) => {
                    props.setCueSequenceId(target.sequenceId);
                    props.setCueId(target.cueId);
                    props.setCueLabel(target.cueLabel || `Cue ${target.cueId}`);
                    props.setCueLabelEdited(false);
                  }}
                  getKey={(target) => target.key}
                  getPrimaryText={(target) =>
                    `Cue ${target.sequenceId}.${target.cueId}`
                  }
                  getSecondaryText={(target) =>
                    `${target.sequenceLabel} - ${target.cueLabel}`
                  }
                  filter={(target, query) => {
                    const text = query.toLowerCase();
                    return (
                      `${target.sequenceId}.${target.cueId}`.includes(text) ||
                      target.sequenceLabel.toLowerCase().includes(text) ||
                      target.cueLabel.toLowerCase().includes(text)
                    );
                  }}
                  placeholder="Filter by sequence, cue number, or label..."
                  emptyMessage="No cues found. Enter IDs below to store a new cue."
                />

                <div class="grid grid-cols-2 gap-3">
                  <label class="text-sm text-neutral-300">
                    <span class="block mb-1">Sequence ID</span>
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      value={props.cueSequenceId}
                      onInput={(event) =>
                        props.setCueSequenceId(
                          clampIdInput(event.currentTarget.valueAsNumber),
                        )
                      }
                    />
                  </label>

                  <label class="text-sm text-neutral-300">
                    <span class="block mb-1">Cue ID</span>
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      value={props.cueId}
                      onInput={(event) =>
                        props.setCueId(
                          clampIdInput(event.currentTarget.valueAsNumber),
                        )
                      }
                    />
                  </label>
                </div>

                <label class="text-sm text-neutral-300 block">
                  <span class="block mb-1">Label</span>
                  <Input
                    type="text"
                    value={props.cueLabel}
                    onInput={(event) => {
                      props.setCueLabel(event.currentTarget.value);
                      props.setCueLabelEdited(true);
                    }}
                  />
                </label>
              </DialogBody>
              <DialogFooter>
                <Button type="button" onClick={props.closeCue}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit">
                  Store Cue
                </Button>
              </DialogFooter>
            </form>
          </DialogSurface>
        </DialogBackdrop>
      </Modal>

      <Modal isOpen={props.showGroup} onEscape={props.closeGroup}>
        <DialogBackdrop>
          <DialogSurface
            class="max-w-lg"
            role="dialog"
            aria-modal="true"
            aria-label="Store Group"
          >
            <form onSubmit={props.storeGroup}>
              <DialogHeader>
                <DialogTitle>Store Group</DialogTitle>
                <DialogCloseButton type="button" onClick={props.closeGroup} />
              </DialogHeader>

              <DialogBody class="space-y-4">
                <ObjectSelector
                  items={props.groupTargets}
                  selectedKey={`${props.groupId}`}
                  onSelect={(target) => {
                    props.setGroupId(target.groupId);
                    props.setGroupLabel(
                      target.label || `Group ${target.groupId}`,
                    );
                    props.setGroupLabelEdited(false);
                  }}
                  getKey={(target) => target.key}
                  getPrimaryText={(target) => `Group ${target.groupId}`}
                  getSecondaryText={(target) => target.label}
                  filter={(target, query) => {
                    const text = query.toLowerCase();
                    return (
                      `${target.groupId}`.includes(text) ||
                      target.label.toLowerCase().includes(text)
                    );
                  }}
                  placeholder="Filter by group number or label..."
                  emptyMessage="No groups found. Enter an ID below to store a new group."
                />

                <label class="text-sm text-neutral-300 block">
                  <span class="block mb-1">Group ID</span>
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={props.groupId}
                    onInput={(event) =>
                      props.setGroupId(
                        clampIdInput(event.currentTarget.valueAsNumber),
                      )
                    }
                  />
                </label>

                <label class="text-sm text-neutral-300 block">
                  <span class="block mb-1">Label</span>
                  <Input
                    type="text"
                    value={props.groupLabel}
                    onInput={(event) => {
                      props.setGroupLabel(event.currentTarget.value);
                      props.setGroupLabelEdited(true);
                    }}
                  />
                </label>
              </DialogBody>
              <DialogFooter>
                <Button type="button" onClick={props.closeGroup}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit">
                  Store Group
                </Button>
              </DialogFooter>
            </form>
          </DialogSurface>
        </DialogBackdrop>
      </Modal>
    </>
  );
}
