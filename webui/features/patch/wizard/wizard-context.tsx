// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createContext,
  createMemo,
  createSignal,
  type ParentComponent,
  useContext,
} from "solid-js";
import { getLogger } from "../../../lib/logger";
import { useSharedStore } from "../../../lib/use-shared-store";
import { fixtures } from "../../../state/appStores";
import type { ConsolePatchProblem } from "../model/console-patch-allocation";

const log = getLogger(import.meta.url);

export type WizardStep =
  | "fixture-selection"
  | "mode-selection"
  | "configure"
  | "review";

const WIZARD_STEPS: WizardStep[] = [
  "fixture-selection",
  "mode-selection",
  "configure",
  "review",
];

const STEP_LABELS: Record<WizardStep, string> = {
  "fixture-selection": "Fixture",
  "mode-selection": "Mode",
  configure: "Configure",
  review: "Review",
};

export interface PatchWizardState {
  fixtureDefinitionId: string | null;
  fixtureMode: string | null;
  assignConsoleDmx: boolean;
  universeId: number | null;
  startAddress: number | null;
  quantity: number;
  /**
   * ID of the first new fixture, the rest numbered after it; null uses the next free ID. Holds
   * whatever number the user typed, so invalid entries stay visible until corrected.
   */
  firstFixtureId: number | null;
  label: string;
  morphFixtureIds: number[];
}

const initialState: PatchWizardState = {
  fixtureDefinitionId: null,
  fixtureMode: null,
  assignConsoleDmx: true,
  universeId: null,
  startAddress: null,
  quantity: 1,
  firstFixtureId: null,
  label: "",
  morphFixtureIds: [],
};

interface OpenPatchWizardOptions {
  morphFixtureIds?: number[];
}

interface PatchWizardContextValue {
  isOpen: () => boolean;
  openWizard: (options?: OpenPatchWizardOptions) => void;
  closeWizard: () => void;
  currentStep: () => WizardStep;
  currentStepIndex: () => number;
  stepCount: () => number;
  stepLabel: (step: WizardStep) => string;
  allSteps: () => WizardStep[];
  goToStep: (step: WizardStep) => void;
  goToNextStep: () => void;
  goToPreviousStep: () => void;
  canGoNext: () => boolean;
  canGoPrevious: () => boolean;
  isLastStep: () => boolean;
  isFirstStep: () => boolean;
  state: () => PatchWizardState;
  /** One past the highest fixture ID in the show, suggested for the first new fixture. */
  nextFixtureId: () => number;
  /** ID the first new fixture receives: the user's choice, or the suggested next ID. */
  baseFixtureId: () => number;
  /** Whether the typed first fixture ID is empty or a whole number from 1. */
  firstFixtureIdValid: () => boolean;
  /** First new fixture ID that an existing fixture already uses, if any. */
  fixtureIdConflict: () => number | undefined;
  updateState: (updates: Partial<PatchWizardState>) => void;
  resetState: () => void;
  /** First reason the configured console patch cannot be applied, set by the configure step. */
  patchProblem: () => ConsolePatchProblem | null;
  setPatchProblem: (problem: ConsolePatchProblem | null) => void;
}

const PatchWizardContext = createContext<PatchWizardContextValue>();

export const PatchWizardProvider: ParentComponent = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [currentStep, setCurrentStep] =
    createSignal<WizardStep>("fixture-selection");
  const [state, setState] = createSignal<PatchWizardState>({ ...initialState });
  const [patchProblem, setPatchProblem] =
    createSignal<ConsolePatchProblem | null>(null);
  const $fixtures = useSharedStore(fixtures);

  /**
   * Suggests numbering new fixtures after the highest ID in the show, so none are overwritten.
   * Reads the show only while the wizard is open, since the provider is always mounted.
   */
  const nextFixtureId = createMemo(() =>
    isOpen()
      ? Object.values($fixtures()).reduce(
          (highest, fixture) => Math.max(highest, fixture.identifiers.id),
          0,
        ) + 1
      : 1,
  );

  /** Whether the typed first fixture ID is usable: empty, or a whole number from 1. */
  const firstFixtureIdValid = createMemo(() => {
    const id = state().firstFixtureId;
    return id === null || (Number.isInteger(id) && id >= 1);
  });

  /** Resolves the first new fixture's ID from the user's choice, falling back to the suggestion. */
  const baseFixtureId = createMemo(() =>
    firstFixtureIdValid()
      ? (state().firstFixtureId ?? nextFixtureId())
      : nextFixtureId(),
  );

  /** Finds the first new fixture ID already used in the show, which Finish would overwrite. */
  const fixtureIdConflict = createMemo(() => {
    if (!isOpen() || state().morphFixtureIds.length > 0) return undefined;
    const existing = new Set(
      Object.values($fixtures()).map((fixture) => fixture.identifiers.id),
    );
    const first = baseFixtureId();
    return Array.from(
      { length: state().quantity },
      (_, index) => first + index,
    ).find((id) => existing.has(id));
  });

  /** Returns the step sequence for either patching new fixtures or morphing existing ones. */
  const activeSteps = createMemo<WizardStep[]>(() =>
    state().morphFixtureIds.length > 0
      ? ["fixture-selection", "mode-selection", "review"]
      : WIZARD_STEPS,
  );

  const currentStepIndex = createMemo(() =>
    activeSteps().indexOf(currentStep()),
  );

  const stepCount = () => activeSteps().length;

  const allSteps = () => activeSteps();

  const stepLabel = (step: WizardStep) => STEP_LABELS[step];

  const isFirstStep = createMemo(() => currentStepIndex() === 0);
  const isLastStep = createMemo(
    () => currentStepIndex() === activeSteps().length - 1,
  );

  const canGoNext = createMemo(() => {
    const step = currentStep();
    const s = state();

    switch (step) {
      case "fixture-selection":
        return s.fixtureDefinitionId !== null;
      case "mode-selection":
        return s.fixtureMode !== null;
      case "configure":
        if (!firstFixtureIdValid() || fixtureIdConflict() !== undefined) {
          return false;
        }
        if (!s.assignConsoleDmx) {
          return s.quantity > 0;
        }
        return (
          s.universeId !== null &&
          s.startAddress !== null &&
          s.quantity > 0 &&
          patchProblem() === null
        );
      case "review":
        return true;
      default:
        return false;
    }
  });

  const canGoPrevious = createMemo(() => !isFirstStep());

  /** Open the wizard with optional existing fixture IDs to update in place. */
  const openWizard = (options: OpenPatchWizardOptions = {}) => {
    log.info("Opening patch wizard");
    const morphFixtureIds = options.morphFixtureIds ?? [];
    setCurrentStep("fixture-selection");
    setState({
      ...initialState,
      assignConsoleDmx: morphFixtureIds.length === 0,
      quantity: morphFixtureIds.length || initialState.quantity,
      morphFixtureIds,
    });
    setPatchProblem(null);
    setIsOpen(true);
  };

  const closeWizard = () => {
    log.info("Closing patch wizard");
    setIsOpen(false);
  };

  const goToStep = (step: WizardStep) => {
    const steps = activeSteps();
    const targetIndex = steps.indexOf(step);
    if (targetIndex >= 0 && targetIndex <= steps.length - 1) {
      log.trace(`Navigating to step: ${step}`);
      setCurrentStep(step);
    }
  };

  const goToNextStep = () => {
    if (!isLastStep() && canGoNext()) {
      const steps = activeSteps();
      const nextIndex = currentStepIndex() + 1;
      setCurrentStep(steps[nextIndex]);
      log.trace(`Moving to next step: ${steps[nextIndex]}`);
    }
  };

  const goToPreviousStep = () => {
    if (!isFirstStep()) {
      const steps = activeSteps();
      const prevIndex = currentStepIndex() - 1;
      setCurrentStep(steps[prevIndex]);
      log.trace(`Moving to previous step: ${steps[prevIndex]}`);
    }
  };

  const updateState = (updates: Partial<PatchWizardState>) => {
    setState((prev) => ({ ...prev, ...updates }));
  };

  const resetState = () => {
    setState({ ...initialState });
    setCurrentStep("fixture-selection");
  };

  const value: PatchWizardContextValue = {
    isOpen,
    openWizard,
    closeWizard,
    currentStep,
    currentStepIndex,
    stepCount,
    stepLabel,
    allSteps,
    goToStep,
    goToNextStep,
    goToPreviousStep,
    canGoNext,
    canGoPrevious,
    isLastStep,
    isFirstStep,
    state,
    nextFixtureId,
    baseFixtureId,
    firstFixtureIdValid,
    fixtureIdConflict,
    updateState,
    resetState,
    patchProblem,
    setPatchProblem,
  };

  return (
    <PatchWizardContext.Provider value={value}>
      {props.children}
    </PatchWizardContext.Provider>
  );
};

export const usePatchWizard = () => {
  const ctx = useContext(PatchWizardContext);
  if (!ctx) {
    throw new Error("usePatchWizard must be used within PatchWizardProvider");
  }
  return ctx;
};
