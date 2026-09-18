// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { CommandAction } from "../../providers/command-registry";

export interface CommandPaletteCommandGroup {
  category: string;
  commands: CommandAction[];
}

const FIELD_WEIGHT = {
  name: 0,
  description: 1000,
  category: 2000,
} as const;

const MATCH_WEIGHT = {
  exact: 0,
  startsWith: 10,
  wordStartsWith: 20,
  includes: 30,
  tokenIncludes: 40,
} as const;

type SearchField = keyof typeof FIELD_WEIGHT;

interface CommandMatchScore {
  score: number;
  index: number;
}

/** Returns the category label used for palette grouping. */
function commandCategory(command: CommandAction): string {
  return command.category || "General";
}

/** Normalizes palette search text for case-insensitive scoring. */
function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Returns whether any word in the candidate starts with the query. */
function hasWordPrefix(candidate: string, query: string): boolean {
  return candidate.split(/\s+/).some((word) => word.startsWith(query));
}

/** Scores one searchable command field against the normalized query. */
function scoreField(
  field: SearchField,
  candidate: string | undefined,
  query: string,
): number | undefined {
  if (!candidate) return undefined;

  const normalizedCandidate = normalizeSearchText(candidate);
  if (!normalizedCandidate) return undefined;

  const fieldWeight = FIELD_WEIGHT[field];
  const lengthWeight = normalizedCandidate.length / 1000;

  if (normalizedCandidate === query) {
    return fieldWeight + MATCH_WEIGHT.exact + lengthWeight;
  }

  if (normalizedCandidate.startsWith(query)) {
    return fieldWeight + MATCH_WEIGHT.startsWith + lengthWeight;
  }

  if (hasWordPrefix(normalizedCandidate, query)) {
    return fieldWeight + MATCH_WEIGHT.wordStartsWith + lengthWeight;
  }

  const phraseIndex = normalizedCandidate.indexOf(query);
  if (phraseIndex >= 0) {
    return fieldWeight + MATCH_WEIGHT.includes + phraseIndex + lengthWeight;
  }

  const terms = query.split(" ");
  if (terms.every((term) => normalizedCandidate.includes(term))) {
    const firstTermIndex = Math.min(
      ...terms.map((term) => normalizedCandidate.indexOf(term)),
    );
    return (
      fieldWeight + MATCH_WEIGHT.tokenIncludes + firstTermIndex + lengthWeight
    );
  }

  return undefined;
}

/** Returns the best search score for a command, or undefined when it does not match. */
function scoreCommand(
  command: CommandAction,
  query: string,
  index: number,
): CommandMatchScore | undefined {
  const scores = [
    scoreField("name", command.name, query),
    scoreField("description", command.description, query),
    scoreField("category", command.category, query),
  ].filter((score): score is number => score !== undefined);

  const score = Math.min(...scores);
  return Number.isFinite(score) ? { score, index } : undefined;
}

/** Filters and ranks command palette commands by match quality for the query. */
export function rankCommandPaletteCommands(
  commands: readonly CommandAction[],
  query: string,
): CommandAction[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [...commands];

  return commands
    .map((command, index) => ({
      command,
      match: scoreCommand(command, normalizedQuery, index),
    }))
    .filter(
      (entry): entry is { command: CommandAction; match: CommandMatchScore } =>
        entry.match !== undefined,
    )
    .sort(
      (left, right) =>
        left.match.score - right.match.score ||
        left.match.index - right.match.index,
    )
    .map((entry) => entry.command);
}

/** Groups commands for palette rendering without losing ranked order when requested. */
export function groupCommandPaletteCommands(
  commands: readonly CommandAction[],
  preserveCommandOrder: boolean,
): CommandPaletteCommandGroup[] {
  if (preserveCommandOrder) {
    const groups: CommandPaletteCommandGroup[] = [];

    for (const command of commands) {
      const category = commandCategory(command);
      const previousGroup = groups[groups.length - 1];
      if (previousGroup?.category === category) {
        previousGroup.commands.push(command);
      } else {
        groups.push({ category, commands: [command] });
      }
    }

    return groups;
  }

  const groups: CommandPaletteCommandGroup[] = [];
  const commandsByCategory = new Map<string, CommandAction[]>();

  for (const command of commands) {
    const category = commandCategory(command);
    let groupCommands = commandsByCategory.get(category);
    if (!groupCommands) {
      groupCommands = [];
      commandsByCategory.set(category, groupCommands);
      groups.push({ category, commands: groupCommands });
    }
    groupCommands.push(command);
  }

  return groups;
}
