// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import "./patch-wizard.css";
import { useStore } from "@nanostores/solid";
import {
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  DialogBackdrop,
  DialogBody,
  DialogCloseButton,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../../components/ui/dialog";
import { createModalScrollLock } from "../../../components/ui/modal/scroll-lock";
import { Button } from "../../../components/ui/visual-language/button";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import {
  computeFixtureChannelCount,
  libraryDefinitionId,
} from "../../../lib/fixture-service";
import { getLogger } from "../../../lib/logger";
import {
  fixtureLibrary,
  fixtureProfile,
  fixtures,
} from "../../../state/appStores";
import { executePatchWizardCommands } from "../services/patch-wizard-commands";
import { StepConfigure } from "./step-configure";
import { StepFinalize } from "./step-finalize";
import { StepSelectFixture } from "./step-select-fixture";
import { StepSelectMode } from "./step-select-mode";
import { usePatchWizard, type WizardStep } from "./wizard-context";

const log = getLogger(import.meta.url);

interface StepIndicatorProps {
  step: WizardStep;
  index: number;
  currentIndex: number;
  label: string;
  isLast: boolean;
}
function StepIndicator(props: StepIndicatorProps) {
  const isCompleted = () => props.index < props.currentIndex;

  const isCurrent = () => props.index === props.currentIndex;

  return (
    <li class="shrink basis-0 flex-1 group">
      <div class="min-w-7 min-h-7 w-full inline-flex items-center text-xs align-middle">
        <span
          class={`size-7 flex justify-center items-center shrink-0 font-medium rounded-full transition-colors ${
            isCompleted()
              ? "bg-[var(--accent)] text-neutral-950"
              : isCurrent()
                ? "border-2 border-[var(--accent)] text-white"
                : "bg-neutral-700 text-neutral-400"
          }`}
        >
          <Show when={isCompleted()} fallback={props.index + 1}>
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path
                fill-rule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clip-rule="evenodd"
              />
            </svg>
          </Show>
        </span>
        <div
          class={`ms-2 w-full h-px flex-1 group-last:hidden transition-colors ${
            isCompleted() ? "bg-[var(--accent)]" : "bg-neutral-700"
          }`}
        />
      </div>
      <div class="mt-3">
        <span
          class={`block text-sm font-medium ${isCurrent() ? "text-white" : "text-neutral-500"}`}
        >
          {props.label}
        </span>
      </div>
    </li>
  );
}

export function PatchWizard() {
  const {
    isOpen,
    closeWizard,
    currentStep,
    currentStepIndex,
    stepLabel,
    allSteps,
    goToNextStep,
    goToPreviousStep,
    canGoNext,
    isLastStep,
    isFirstStep,
  } = usePatchWizard();

  const { state } = usePatchWizard();
  const $fixtures = useStore(fixtures);
  const $fixtureLibrary = useStore(fixtureLibrary);
  const $fixtureProfile = useStore(fixtureProfile);
  const [isCreating, setIsCreating] = createSignal(false);
  const [isVersionConflictModalOpen, setIsVersionConflictModalOpen] =
    createSignal(false);
  const [versionConflictFixtureIds, setVersionConflictFixtureIds] =
    createSignal<number[]>([]);
  /** Tracks when the wizard is updating existing fixture definitions. */
  const isMorphMode = createMemo(() => state().morphFixtureIds.length > 0);

  createModalScrollLock(isOpen);

  /** Calculate the next available fixture ID */
  const nextFixtureId = createMemo(() => {
    const fixtureData = $fixtures();
    let maxId = 0;
    for (const fixture of Object.values(fixtureData)) {
      if (fixture.identifiers.id > maxId) {
        maxId = fixture.identifiers.id;
      }
    }
    return maxId + 1;
  });

  /** Check for ID conflicts */
  const hasIdConflict = createMemo(() => {
    if (isMorphMode()) return false;

    const fixtureData = $fixtures();
    const baseId = nextFixtureId();
    const qty = state().quantity;
    const existingIds = new Set(
      Object.values(fixtureData).map((f) => f.identifiers.id),
    );

    for (let i = 0; i < qty; i++) {
      if (existingIds.has(baseId + i)) {
        return true;
      }
    }
    return false;
  });

  /** Get channel count from profile fixture metadata for address offset calculation */
  const channelCount = createMemo(() => {
    const profile = $fixtureProfile();
    if (profile?.fixture) {
      return computeFixtureChannelCount(profile.fixture);
    }
    return null;
  });

  const selectedLibraryFixtureInfo = createMemo(() => {
    const fixtureDefinitionId = state().fixtureDefinitionId;
    if (!fixtureDefinitionId) return null;
    return $fixtureLibrary().find(
      (fixture) => libraryDefinitionId(fixture) === fixtureDefinitionId,
    );
  });
  const selectedLibraryFixture = createMemo(() => {
    const s = state();
    if (!s.fixtureDefinitionId || !s.fixtureMode) return null;

    const profile = $fixtureProfile();
    if (!profile?.fixture) return null;
    if (libraryDefinitionId(profile.info) !== s.fixtureDefinitionId) {
      return null;
    }
    if (profile.fixture.mode !== s.fixtureMode) return null;

    return profile.fixture;
  });
  const selectedLibraryGeometry = createMemo(() => {
    const fixtureDefinitionId = state().fixtureDefinitionId;
    const fixtureMode = state().fixtureMode;
    const profile = $fixtureProfile();
    if (!fixtureDefinitionId || !fixtureMode || !profile?.geometry) {
      return null;
    }

    if (libraryDefinitionId(profile.info) !== fixtureDefinitionId) {
      return null;
    }

    if (profile.fixture?.mode !== fixtureMode) {
      return null;
    }

    return profile.geometry;
  });

  const closeVersionConflictModal = () => {
    setIsVersionConflictModalOpen(false);
    setVersionConflictFixtureIds([]);
  };

  /** Runs feature commands for the current wizard state and handles UI lifecycle state. */
  const finishWithOptions = async (forceUpdateExisting = false) => {
    const profileFixture = selectedLibraryFixture();
    const libraryFixtureInfo = selectedLibraryFixtureInfo();
    if (!profileFixture || !libraryFixtureInfo || isCreating()) return;

    setIsCreating(true);
    const result = await executePatchWizardCommands({
      state: state(),
      fixtures: $fixtures(),
      profileFixture,
      libraryFixtureInfo,
      geometry: selectedLibraryGeometry(),
      baseFixtureId: nextFixtureId(),
      channelCount: channelCount() ?? 1,
      forceUpdateExisting,
    });

    if (result.status === "conflict") {
      setIsCreating(false);
      setVersionConflictFixtureIds(result.fixtureIds);
      setIsVersionConflictModalOpen(true);
      return;
    }

    setIsCreating(false);
    closeVersionConflictModal();
    closeWizard();
  };
  const handleFinish = () => {
    void finishWithOptions(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!isOpen()) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!isCreating()) {
        closeWizard();
      }
    } else if (e.key === "Enter" && canGoNext() && !isCreating()) {
      e.preventDefault();
      e.stopPropagation();
      if (isLastStep()) {
        handleFinish();
      } else {
        goToNextStep();
      }
    }
  };

  onMount(() => {
    log.trace("mounting");
    document.addEventListener("keydown", handleKeyDown, true);
  });

  onCleanup(() => {
    log.trace("unmounting");
    document.removeEventListener("keydown", handleKeyDown, true);
  });

  return (
    <Show when={isOpen()}>
      <Portal>
        <DialogBackdrop
          role="dialog"
          aria-modal="true"
          aria-label="Patch Wizard"
          onKeyDown={(e) => e.key === "Enter" && e.stopPropagation()}
        >
          <DialogSurface
            role="document"
            class="nf-patch-wizard max-w-[700px] h-[85dvh]"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <DialogHeader>
              <DialogTitle>
                {isMorphMode() ? "Morph Fixture" : "Patch Wizard"}
              </DialogTitle>
              <DialogCloseButton
                type="button"
                onClick={closeWizard}
              ></DialogCloseButton>
            </DialogHeader>

            {/* Stepper */}
            <div class="py-6 px-8 border-b border-gray-700">
              <ul class="relative flex flex-row gap-x-2">
                <For each={allSteps()}>
                  {(step, index) => (
                    <StepIndicator
                      step={step}
                      index={index()}
                      currentIndex={currentStepIndex()}
                      label={stepLabel(step)}
                      isLast={index() === allSteps().length - 1}
                    />
                  )}
                </For>
              </ul>
            </div>

            {/* Content Area */}
            <DialogBody>
              <Switch>
                <Match when={currentStep() === "fixture-selection"}>
                  <StepSelectFixture />
                </Match>
                <Match when={currentStep() === "mode-selection"}>
                  <StepSelectMode />
                </Match>
                <Match when={currentStep() === "configure"}>
                  <StepConfigure />
                </Match>
                <Match when={currentStep() === "review"}>
                  <StepFinalize />
                </Match>
              </Switch>
            </DialogBody>

            {/* Footer with navigation */}
            <DialogFooter
              style={{ "flex-direction": "column", "align-items": "stretch" }}
            >
              {/* ID conflict warning */}
              <Show when={hasIdConflict() && isLastStep()}>
                <div class="px-4 pt-3 pb-0">
                  <div class="bg-yellow-900/40 border border-yellow-700 rounded px-3 py-2 text-sm text-yellow-200 flex items-center gap-2">
                    <svg
                      class="w-4 h-4 flex-shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fill-rule="evenodd"
                        d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                        clip-rule="evenodd"
                      />
                    </svg>
                    <span>
                      Warning: One or more fixture IDs already exist. Creating
                      will overwrite existing fixtures.
                    </span>
                  </div>
                </div>
              </Show>

              <div class="flex flex-wrap items-center justify-between gap-2">
                <Button
                  size="compact"
                  type="button"
                  onClick={goToPreviousStep}
                  disabled={isFirstStep() || isCreating()}
                >
                  Previous
                </Button>

                <div class="flex gap-3">
                  <Button
                    size="compact"
                    type="button"
                    onClick={closeWizard}
                    disabled={isCreating()}
                  >
                    Cancel
                  </Button>

                  <Show
                    when={!isLastStep()}
                    fallback={
                      <Button
                        size="compact"
                        type="button"
                        onClick={handleFinish}
                        disabled={!canGoNext() || isCreating()}
                        variant="primary"
                      >
                        <Show when={isCreating()}>
                          <svg
                            class="w-4 h-4 animate-spin"
                            fill="none"
                            viewBox="0 0 24 24"
                          >
                            <circle
                              class="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              stroke-width="4"
                            />
                            <path
                              class="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                        </Show>
                        <span>
                          {isCreating()
                            ? isMorphMode()
                              ? "Morphing..."
                              : "Creating..."
                            : isMorphMode()
                              ? "Morph"
                              : "Finish"}
                        </span>
                      </Button>
                    }
                  >
                    <Button
                      size="compact"
                      type="button"
                      onClick={goToNextStep}
                      disabled={!canGoNext()}
                      variant="primary"
                    >
                      Next
                    </Button>
                  </Show>
                </div>
              </div>
            </DialogFooter>
          </DialogSurface>
        </DialogBackdrop>
      </Portal>
      <DeleteConfirmModal
        isOpen={isVersionConflictModalOpen()}
        title="Version Mismatch Detected"
        message={`This showfile already contains fixture IDs ${versionConflictFixtureIds().join(", ")} with a different ${state().fixtureDefinitionId ?? "fixture"} version. Proceeding will update those fixtures to the library version before adding the new fixture(s).`}
        confirmLabel="Proceed and Update"
        onCancel={closeVersionConflictModal}
        onConfirm={() => {
          setIsVersionConflictModalOpen(false);
          void finishWithOptions(true);
        }}
      />
    </Show>
  );
}
