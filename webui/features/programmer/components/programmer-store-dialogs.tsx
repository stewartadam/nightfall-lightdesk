// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  Dialog,
  DialogBody,
  DialogCancelButton,
  DialogFooter,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/form-controls";
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
      <Dialog
        kind="task"
        isOpen={props.showCue}
        title="Store Cue"
        onDismiss={props.closeCue}
      >
        <form onSubmit={props.storeCue}>
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
            <DialogCancelButton />
            <Button variant="primary" type="submit">
              Store Cue
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      <Dialog
        kind="task"
        isOpen={props.showGroup}
        title="Store Group"
        onDismiss={props.closeGroup}
      >
        <form onSubmit={props.storeGroup}>
          <DialogBody class="space-y-4">
            <ObjectSelector
              items={props.groupTargets}
              selectedKey={`${props.groupId}`}
              onSelect={(target) => {
                props.setGroupId(target.groupId);
                props.setGroupLabel(target.label || `Group ${target.groupId}`);
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
            <DialogCancelButton />
            <Button variant="primary" type="submit">
              Store Group
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </>
  );
}
