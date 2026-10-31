// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import * as types from "../../../types";

/** One way to start a new fixture, as offered on the editor's start page. */
export interface DraftStarter {
  /** Stable key for tests and list rendering. */
  id: string;
  label: string;
  description: string;
  source: types.DraftSource;
}

/** Starting points for a new fixture: an empty profile, then the generic templates. */
export const DRAFT_STARTERS: readonly DraftStarter[] = [
  {
    id: "blank",
    label: "Blank",
    description: "A par body with one empty mode",
    source: { type: "Blank" },
  },
  {
    id: "dimmer",
    label: "Dimmer",
    description: "1 channel: dimmer",
    source: { type: "Template", data: types.DraftTemplate.Dimmer },
  },
  {
    id: "rgb",
    label: "RGB",
    description: "3 channels: red, green, blue",
    source: { type: "Template", data: types.DraftTemplate.Rgb },
  },
  {
    id: "rgbw",
    label: "RGBW",
    description: "4 channels: red, green, blue, white",
    source: { type: "Template", data: types.DraftTemplate.Rgbw },
  },
  {
    id: "rgbawuv",
    label: "RGBAW UV",
    description: "6 channels: red, green, blue, amber, white, UV",
    source: { type: "Template", data: types.DraftTemplate.Rgbawuv },
  },
  {
    id: "dimmer-rgb-strobe",
    label: "Dimmer RGB Strobe",
    description: "5 channels: dimmer, red, green, blue, strobe",
    source: { type: "Template", data: types.DraftTemplate.DimmerRgbStrobe },
  },
  {
    id: "moving-head",
    label: "Moving Head",
    description:
      "8 channels: 16-bit pan and tilt, dimmer, shutter, color wheel",
    source: { type: "Template", data: types.DraftTemplate.MovingHead },
  },
];

/** Source format the backend reports for GDTF library fixtures, the only ones drafts can open. */
const GDTF_SOURCE_FORMAT = "GDTF";

/** Most library fixtures listed at once; a search narrows longer lists. */
export const LIBRARY_RESULT_LIMIT = 100;

/** Describes what a draft was opened from, for its row on the start page. */
export function draftOriginLabel(origin: types.DraftSource): string {
  switch (origin.type) {
    case "Blank":
      return "New fixture";
    case "Template":
      return `New from the ${
        DRAFT_STARTERS.find(
          (starter) =>
            starter.source.type === "Template" &&
            starter.source.data === origin.data,
        )?.label ?? origin.data
      } template`;
    case "Duplicate":
      return `Copy of ${origin.data.make} ${origin.data.model}`;
    case "Edit":
      return `Editing ${origin.data.make} ${origin.data.model}`;
  }
}

/** Library fixtures a draft can open, as returned by `matchingLibraryFixtures`. */
export interface LibraryMatches {
  fixtures: types.AvailableFixtureInfo[];
  /** Matches left out by the result limit. */
  hidden: number;
}

/**
 * Lists the GDTF fixtures whose manufacturer or model contains every word of
 * the query, sorted by manufacturer then model and capped at the result limit.
 */
export function matchingLibraryFixtures(
  fixtures: readonly types.AvailableFixtureInfo[],
  query: string,
): LibraryMatches {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = fixtures
    .filter((fixture) => fixture.source_format === GDTF_SOURCE_FORMAT)
    .filter((fixture) => {
      const text = `${fixture.make} ${fixture.model}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort(
      (a, b) =>
        a.make.localeCompare(b.make) ||
        a.model.localeCompare(b.model) ||
        a.asset_etag.localeCompare(b.asset_etag),
    );
  return {
    fixtures: matches.slice(0, LIBRARY_RESULT_LIMIT),
    hidden: Math.max(0, matches.length - LIBRARY_RESULT_LIMIT),
  };
}

/** Names the library revision a draft opens, so a pinned revision is edited, not the default. */
export function libraryEntry(
  fixture: types.AvailableFixtureInfo,
): types.FixtureLibraryEntry {
  return {
    make: fixture.make,
    model: fixture.model,
    asset_etag: fixture.asset_etag,
  };
}

/** Counts a draft's errors and warnings for its summary line. */
export function problemCounts(problems: readonly types.DraftProblem[]): {
  errors: number;
  warnings: number;
} {
  const errors = problems.filter(
    (problem) => problem.severity === types.ProblemSeverity.Error,
  ).length;
  return { errors, warnings: problems.length - errors };
}
