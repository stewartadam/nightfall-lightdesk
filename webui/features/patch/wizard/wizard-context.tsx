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
  label: string;
  morphFixtureIds: number[];
}

interface PatchConflictInfo {
  hasConflict: boolean;
  /** Universe where the conflict occurs */
  conflictingUniverse?: number;
  /** Details about the first conflicting address, if any */
  conflictingAddress?: number;
  /** Label/name of the fixture that owns the conflicting address */
  conflictingFixtureLabel?: string;
}

const initialState: PatchWizardState = {
  fixtureDefinitionId: null,
  fixtureMode: null,
  assignConsoleDmx: true,
  universeId: null,
  startAddress: null,
  quantity: 1,
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
  updateState: (updates: Partial<PatchWizardState>) => void;
  resetState: () => void;
  /** Patch conflict info set by the configure step */
  patchConflict: () => PatchConflictInfo;
  setPatchConflict: (info: PatchConflictInfo) => void;
}

const PatchWizardContext = createContext<PatchWizardContextValue>();

export const PatchWizardProvider: ParentComponent = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [currentStep, setCurrentStep] =
    createSignal<WizardStep>("fixture-selection");
  const [state, setState] = createSignal<PatchWizardState>({ ...initialState });
  const [patchConflict, setPatchConflict] = createSignal<PatchConflictInfo>({
    hasConflict: false,
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
        if (!s.assignConsoleDmx) {
          return s.quantity > 0;
        }
        return (
          s.universeId !== null &&
          s.startAddress !== null &&
          s.quantity > 0 &&
          !patchConflict().hasConflict
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
    setPatchConflict({ hasConflict: false });
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
    updateState,
    resetState,
    patchConflict,
    setPatchConflict,
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
