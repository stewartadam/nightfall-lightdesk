// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createContext,
  createSignal,
  type ParentComponent,
  useContext,
} from "solid-js";

interface ObjectPatchWizardContextValue {
  isOpen: () => boolean;
  openWizard: () => void;
  closeWizard: () => void;
}

const ObjectPatchWizardContext = createContext<ObjectPatchWizardContextValue>();

export const ObjectPatchWizardProvider: ParentComponent = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);

  const openWizard = () => setIsOpen(true);

  const closeWizard = () => setIsOpen(false);

  return (
    <ObjectPatchWizardContext.Provider
      value={{ isOpen, openWizard, closeWizard }}
    >
      {props.children}
    </ObjectPatchWizardContext.Provider>
  );
};

export const useObjectPatchWizard = () => {
  const context = useContext(ObjectPatchWizardContext);
  if (!context) {
    throw new Error(
      "useObjectPatchWizard must be used within ObjectPatchWizardProvider",
    );
  }
  return context;
};
