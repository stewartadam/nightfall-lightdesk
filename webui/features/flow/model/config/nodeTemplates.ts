// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Node templates for the flow editor.
 * Templates are sourced from the backend during resync.
 */

import { flowNodeTemplates } from "../../../../state/appStores";
import type { FlowPortDefinition } from "../../../../types/index";

/**
 * Node template definition.
 */
export type FlowNodeTemplate = {
  kind: string;
  label: string;
  ports: FlowPortDefinition[];
};

/**
 * Get available node templates, using backend-sourced templates as primary source.
 */
export function getAvailableNodeTemplates(
  flowNodes: Array<{ kind: string; ports: FlowPortDefinition[] }>,
  formatLabel: (kind: string) => string,
): FlowNodeTemplate[] {
  const templates = new Map<string, FlowNodeTemplate>();

  // Priority 1: Backend-sourced templates (primary source of truth)
  const backendDescriptors = flowNodeTemplates.get();
  for (const descriptor of backendDescriptors) {
    templates.set(descriptor.kind, {
      kind: descriptor.kind,
      label: descriptor.label,
      ports: descriptor.ports,
    });
  }

  // Priority 2: Templates from existing flow nodes (for unknown types)
  for (const node of flowNodes) {
    if (!templates.has(node.kind)) {
      templates.set(node.kind, {
        kind: node.kind,
        label: formatLabel(node.kind),
        ports: node.ports,
      });
    }
  }

  // Sort by label
  return Array.from(templates.values()).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}
