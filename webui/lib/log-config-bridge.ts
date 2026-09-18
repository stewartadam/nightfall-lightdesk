// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "off"]);

function splitLogDirectives(config: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depthSquare = 0;
  let depthCurly = 0;
  let depthParen = 0;

  for (const ch of config) {
    if (
      ch === "," &&
      depthSquare === 0 &&
      depthCurly === 0 &&
      depthParen === 0
    ) {
      const value = current.trim();
      if (value.length > 0) {
        parts.push(value);
      }
      current = "";
      continue;
    }

    current += ch;
    if (ch === "[") depthSquare += 1;
    else if (ch === "]") depthSquare = Math.max(0, depthSquare - 1);
    else if (ch === "{") depthCurly += 1;
    else if (ch === "}") depthCurly = Math.max(0, depthCurly - 1);
    else if (ch === "(") depthParen += 1;
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
  }

  const tail = current.trim();
  if (tail.length > 0) {
    parts.push(tail);
  }
  return parts;
}

function asLogLevel(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return LOG_LEVELS.has(normalized) ? normalized : null;
}

function isScopedDirective(directive: string): boolean {
  return /^[^=]+\[[^\]]+\]=/i.test(directive.trim());
}

function nightfallLevelFromDirective(directive: string): string | null {
  const match = directive.match(
    /^nightfall=(trace|debug|info|warn|error|off)$/i,
  );
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Convert backend log config syntax into UI logger syntax.
 *
 * Backend commands commonly use `nightfall=...` to target engine logs.
 * When present, we bind that level to the UI global/default level so
 * `log level nightfall=debug,...` also raises UI verbosity.
 */
export function backendLogConfigToUi(config: string): string {
  const trimmed = config.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "clear") {
    return "info";
  }

  const directives = splitLogDirectives(trimmed);
  if (directives.length === 0) {
    return "info";
  }

  let nightfallLevel: string | null = null;
  let explicitDefault: string | null = null;
  const uiOverrides: string[] = [];

  for (const directive of directives) {
    if (isScopedDirective(directive)) {
      // Span-scoped directives do not have a meaningful equivalent in UI logging.
      continue;
    }

    const level = asLogLevel(directive);
    if (level) {
      explicitDefault = level;
      continue;
    }

    const nightfall = nightfallLevelFromDirective(directive);
    if (nightfall) {
      nightfallLevel = nightfall;
      continue;
    }

    uiOverrides.push(directive);
  }

  const uiDefault = nightfallLevel ?? explicitDefault;
  if (uiDefault) {
    return [uiDefault, ...uiOverrides].join(",");
  }

  if (uiOverrides.length > 0) {
    return uiOverrides.join(",");
  }

  return "info";
}
