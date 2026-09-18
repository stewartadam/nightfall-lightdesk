// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Module-based logging system for Nightfall UI.
 *
 * Provides RUST_LOG-style filtering with runtime configuration:
 * - Default level applies to all modules not explicitly configured
 * - Module-specific levels override the default
 * - Runtime configuration via window.nightfallLog.configure()
 *
 * Configuration syntax: "level" or "default_level,module1=level,module2=level"
 * Examples:
 *   "warn"                              - All modules at warn level
 *   "warn,websocket=debug"              - Default warn, websocket at debug
 *   "error,visualizer=debug,flow=info" - Multiple module overrides
 *
 * @module logger
 */
import { LogLevelPriority } from "@loglayer/shared";
import { ConsoleTransport, LogLayer, LogLevel } from "loglayer";
import { serializeError } from "serialize-error";
import "./diagnostic-console";

/**
 * Extended message data type that accepts any value for logging.
 * Objects and errors will be serialized appropriately.
 */
type LogMessageArg = unknown;

/**
 * localStorage key for persisted log configuration.
 */
const STORAGE_KEY = "nightfall-log-config";

/**
 * URL parameter name for log level configuration.
 */
const URL_PARAM = "logLevel";
const DEFAULT_LOG_LEVEL = import.meta.env?.DEV ? LogLevel.debug : LogLevel.info;

/**
 * Parse a RUST_LOG-style configuration string.
 *
 * Format: "default_level" or "default_level,module1=level,module2=level"
 *
 * @param config - Configuration string like "warn,websocket=debug"
 * @returns Parsed configuration with defaultLevel and moduleOverrides
 */
function parseLogConfig(config: string): {
  defaultLevel: LogLevel;
  moduleOverrides: Map<string, LogLevel>;
} {
  const moduleOverrides = new Map<string, LogLevel>();
  let defaultLevel: LogLevel = LogLevel.info;

  const parts = config.split(",").map((p) => p.trim());

  for (const part of parts) {
    if (!part) continue;

    if (part.includes("=")) {
      // Module-specific: "websocket=debug"
      const [module, level] = part.split("=").map((s) => s.trim());
      if (
        module &&
        level &&
        Object.values(LogLevel).includes(level as LogLevel)
      ) {
        moduleOverrides.set(module.toLowerCase(), level as LogLevel);
      }
    } else if (Object.values(LogLevel).includes(part as LogLevel)) {
      // Default level: "warn"
      defaultLevel = part as LogLevel;
    }
  }

  return { defaultLevel, moduleOverrides };
}

/**
 * Global logging configuration state.
 */
interface LogConfig {
  defaultLevel: LogLevel;
  moduleOverrides: Map<string, LogLevel>;
}

let currentConfig: LogConfig = {
  defaultLevel: DEFAULT_LOG_LEVEL,
  moduleOverrides: new Map(),
};

/**
 * Serializable format of log configuration for cross-thread transfer.
 */
export interface SerializedLogConfig {
  defaultLevel: LogLevel;
  moduleOverrides: Record<string, LogLevel>;
}

/**
 * Subscribers for config change notifications.
 */
type ConfigChangeCallback = (config: SerializedLogConfig) => void;
const configChangeListeners = new Set<ConfigChangeCallback>();

/**
 * Notify all listeners of config changes.
 */
function notifyConfigChange(): void {
  const config = getConfig();
  for (const listener of configChangeListeners) {
    try {
      listener(config);
    } catch {
      // Ignore errors in listeners
    }
  }
}

/**
 * Map of module name -> LogLayer instance for reuse.
 */
const moduleLoggers = new Map<string, ModuleLogger>();

/**
 * Resolve the effective log level for a module.
 *
 * Resolution order:
 * 1. Exact override match (case-insensitive), e.g. `stores:fixture`.
 * 2. Shorthand suffix override match on full module path segments,
 *    e.g. `fixture=trace` matches `stores:fixture`.
 * 3. Default global level.
 *
 * When multiple suffix overrides match, the most specific (longest suffix)
 * wins.
 */
function resolveModuleLevel(module: string): LogLevel {
  const normalizedModule = module.toLowerCase();
  const exactOverride = currentConfig.moduleOverrides.get(normalizedModule);
  if (exactOverride) {
    return exactOverride;
  }

  let bestMatch: { level: LogLevel; keyLength: number } | null = null;
  for (const [overrideModule, overrideLevel] of currentConfig.moduleOverrides) {
    if (normalizedModule.endsWith(`:${overrideModule}`)) {
      if (!bestMatch || overrideModule.length > bestMatch.keyLength) {
        bestMatch = { level: overrideLevel, keyLength: overrideModule.length };
      }
    }
  }

  return bestMatch?.level ?? currentConfig.defaultLevel;
}

function shouldLog(module: string, level: LogLevel): boolean {
  const moduleLevel = resolveModuleLevel(module);
  return LogLevelPriority[level] >= LogLevelPriority[moduleLevel];
}

/**
 * Wrapper around LogLayer that filters based on module configuration.
 * Provides the standard logging methods with automatic prefix and filtering.
 */
export class ModuleLogger {
  private readonly module: string;
  private readonly prefix: string;
  private readonly layer: LogLayer;

  constructor(module: string) {
    this.module = module.toLowerCase();
    this.prefix = `[${module}]`;
    this.layer = new LogLayer({
      errorSerializer: serializeError,
      transport: new ConsoleTransport({
        logger: console,
      }),
      prefix: this.prefix,
    });
  }

  /**
   * Get the effective log level for this module.
   */
  getEffectiveLevel(): LogLevel {
    return resolveModuleLevel(this.module);
  }

  /**
   * Check whether this module would emit a message at the given level.
   */
  isEnabled(level: LogLevel): boolean {
    return shouldLog(this.module, level);
  }

  trace(...args: LogMessageArg[]): void {
    if (shouldLog(this.module, LogLevel.trace)) {
      this.layer.trace(...(args as string[]));
    }
  }

  debug(...args: LogMessageArg[]): void {
    if (shouldLog(this.module, LogLevel.debug)) {
      this.layer.debug(...(args as string[]));
    }
  }

  info(...args: LogMessageArg[]): void {
    if (shouldLog(this.module, LogLevel.info)) {
      this.layer.info(...(args as string[]));
    }
  }

  warn(...args: LogMessageArg[]): void {
    if (shouldLog(this.module, LogLevel.warn)) {
      this.layer.warn(...(args as string[]));
    }
  }

  error(...args: LogMessageArg[]): void {
    if (shouldLog(this.module, LogLevel.error)) {
      this.layer.error(...(args as string[]));
    }
  }

  /**
   * Log with attached error object for stack traces.
   * Accepts any value and converts non-Error values internally.
   */
  errorWithCause(err: unknown, ...args: LogMessageArg[]): void {
    if (shouldLog(this.module, LogLevel.error)) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.layer.withError(error).error(...(args as string[]));
    }
  }

  /**
   * Log with additional metadata object.
   */
  withMetadata(metadata: Record<string, unknown>): {
    trace: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    errorWithCause: (err: unknown, ...args: LogMessageArg[]) => void;
  } {
    const layer = this.layer.withMetadata(metadata);
    const module = this.module;

    return {
      trace: (...args: unknown[]) => {
        if (shouldLog(module, LogLevel.trace))
          layer.trace(...(args as string[]));
      },
      debug: (...args: unknown[]) => {
        if (shouldLog(module, LogLevel.debug))
          layer.debug(...(args as string[]));
      },
      info: (...args: unknown[]) => {
        if (shouldLog(module, LogLevel.info)) layer.info(...(args as string[]));
      },
      warn: (...args: unknown[]) => {
        if (shouldLog(module, LogLevel.warn)) layer.warn(...(args as string[]));
      },
      error: (...args: unknown[]) => {
        if (shouldLog(module, LogLevel.error))
          layer.error(...(args as string[]));
      },
      errorWithCause: (err: unknown, ...args: LogMessageArg[]) => {
        if (shouldLog(module, LogLevel.error)) {
          const error = err instanceof Error ? err : new Error(String(err));
          layer.withError(error).error(...(args as string[]));
        }
      },
    };
  }
}

/**
 * Create or retrieve a logger for the specified module.
 *
 * Module names are case-insensitive and will be displayed in brackets:
 * createLogger('websocket') logs as "[websocket] message"
 *
 * @param module - Module name (e.g., 'websocket', 'visualizer', 'flow')
 * @returns ModuleLogger instance
 *
 * @example
 * const log = createLogger('websocket');
 * log.debug('Connection established');
 * log.warn('Reconnecting...');
 */
export function createLogger(module: string): ModuleLogger {
  const key = module.toLowerCase();
  let logger = moduleLoggers.get(key);
  if (!logger) {
    logger = new ModuleLogger(module);
    moduleLoggers.set(key, logger);
  }
  return logger;
}

/**
 * Derive a module name from a file path.
 *
 * Transforms paths like:
 * - `src/stores/fixture.ts` → `stores:fixture`
 * - `src/components/panels/Properties.tsx` → `components:panels:Properties`
 * - `file:///path/to/webui/lib/engine-runtime.ts` → `lib:websocket`
 *
 * @param filePath - File path or import.meta.url
 * @returns Derived module name
 */
export function moduleNameFromPath(filePath: string): string {
  // Handle file:// URLs (from import.meta.url)
  let path = filePath;
  if (path.startsWith("file://")) {
    path = path.slice(7);
  }

  // Remove query strings and hashes (e.g., ?t=123 for HMR)
  const queryIndex = path.indexOf("?");
  if (queryIndex !== -1) {
    path = path.slice(0, queryIndex);
  }
  const hashIndex = path.indexOf("#");
  if (hashIndex !== -1) {
    path = path.slice(0, hashIndex);
  }

  // Find the webui directory as our base
  const webuiIndex = path.indexOf("/webui/");
  if (webuiIndex !== -1) {
    path = path.slice(webuiIndex + 7); // +7 for "/webui/"
  } else {
    // Fallback: just use the filename without extension
    const lastSlash = path.lastIndexOf("/");
    path = lastSlash !== -1 ? path.slice(lastSlash + 1) : path;
  }

  // Remove file extension (.ts, .tsx, .js, .jsx)
  path = path.replace(/\.(tsx?|jsx?)$/, "");

  // Remove /index suffix (index files represent the directory)
  path = path.replace(/\/index$/, "");

  // Convert path separators to colons
  return path.replace(/\//g, ":");
}

/**
 * Create or retrieve a logger with the module name derived from the file path.
 *
 * This is the preferred way to create loggers as it automatically derives
 * the module name from the file location, similar to Rust's tracing crate.
 *
 * @param importMetaUrl - Pass `import.meta.url` to auto-derive the module name
 * @returns ModuleLogger instance
 *
 * @example
 * // In src/stores/fixture.ts
 * const log = getLogger(import.meta.url);
 * // Creates logger with module name "stores:fixture"
 *
 * log.debug('Loading fixtures');
 * // Output: [stores:fixture] Loading fixtures
 */
export function getLogger(importMetaUrl: string): ModuleLogger {
  const moduleName = moduleNameFromPath(importMetaUrl);
  return createLogger(moduleName);
}

/**
 * Configure the logging system at runtime.
 * Replaces the full in-memory config (default + overrides) with the parsed
 * value from `config`; previous overrides are not merged.
 *
 * @param config - RUST_LOG-style configuration string
 * @param persist - Whether to save to localStorage (default: true)
 *
 * @example
 * configure('warn');                    // All modules at warn level
 * configure('warn,websocket=debug');    // Exact module override
 * configure('info,geometry-builder=trace'); // Shorthand suffix override
 * configure('info');                    // Clears prior overrides
 */
export function configure(config: string, persist = true): void {
  const parsed = parseLogConfig(config);
  currentConfig = parsed;

  // Log the configuration change
  const overrides = Array.from(parsed.moduleOverrides.entries())
    .map(([m, l]) => `${m}=${l}`)
    .join(", ");

  console.info(
    `[logger] Configured: default=${parsed.defaultLevel}${overrides ? `, ${overrides}` : ""}`,
  );

  if (persist) {
    saveConfig();
  }

  notifyConfigChange();
}

/**
 * Get the current logging configuration.
 */
export function getConfig(): {
  defaultLevel: LogLevel;
  moduleOverrides: Record<string, LogLevel>;
} {
  return {
    defaultLevel: currentConfig.defaultLevel,
    moduleOverrides: Object.fromEntries(currentConfig.moduleOverrides),
  };
}

/**
 * Set the global (default) log level for all modules without explicit overrides.
 *
 * @param level - The log level to set as default
 * @param persist - Whether to save to localStorage (default: true)
 *
 * @example
 * setGlobalLogLevel('debug');  // All modules at debug unless overridden
 */
function setGlobalLogLevel(level: LogLevel, persist = true): void {
  currentConfig.defaultLevel = level;
  console.info(`[logger] Global level set to: ${level}`);

  if (persist) {
    saveConfig();
  }

  notifyConfigChange();
}

/**
 * Set the log level for a specific module.
 *
 * @param module - Module override key (case-insensitive), supports exact names
 *   and shorthand suffixes (for example `geometry-builder`)
 * @param level - The log level, or null to clear the override
 * @param persist - Whether to save to localStorage (default: true)
 *
 * @example
 * setModuleLogLevel('stores:fixture', 'debug');  // exact override
 * setModuleLogLevel('fixture', 'trace');         // suffix override
 * setModuleLogLevel('fixture', null);            // clear override, use default
 */
export function setModuleLogLevel(
  module: string,
  level: LogLevel | null,
  persist = true,
): void {
  const key = module.toLowerCase();

  if (level === null) {
    currentConfig.moduleOverrides.delete(key);
    console.info(`[logger] Cleared override for module: ${module}`);
  } else {
    currentConfig.moduleOverrides.set(key, level);
    console.info(`[logger] Module ${module} set to: ${level}`);
  }

  if (persist) {
    saveConfig();
  }

  notifyConfigChange();
}

/**
 * List all registered module loggers and their effective levels.
 */
function listModules(): Record<string, LogLevel> {
  const result: Record<string, LogLevel> = {};
  for (const [name, logger] of moduleLoggers) {
    result[name] = logger.getEffectiveLevel();
  }
  return result;
}

/**
 * Subscribe to log configuration changes.
 * Useful for synchronizing config to workers or other contexts.
 *
 * @param callback Function called with the new config whenever it changes
 * @returns Unsubscribe function
 */
export function subscribeToConfigChanges(
  callback: (config: SerializedLogConfig) => void,
): () => void {
  configChangeListeners.add(callback);
  return () => configChangeListeners.delete(callback);
}

/**
 * Apply a serialized log configuration.
 * Used by workers to sync config from the main thread.
 *
 * @param config Serialized configuration from getConfig()
 */
export function applySerializedConfig(config: SerializedLogConfig): void {
  currentConfig.defaultLevel = config.defaultLevel;
  currentConfig.moduleOverrides = new Map(
    Object.entries(config.moduleOverrides),
  );

  // Log change but don't persist (worker doesn't have localStorage)
  // and don't notify (this is a sync, not an originating change)
  const overrides = Object.entries(config.moduleOverrides)
    .map(([m, l]) => `${m}=${l}`)
    .join(", ");

  console.info(
    `[logger] Config synced: default=${config.defaultLevel}${overrides ? `, ${overrides}` : ""}`,
  );
}

/**
 * Save current configuration to localStorage.
 */
function saveConfig(): void {
  if (typeof localStorage === "undefined") return;

  const configStr = configToString();
  try {
    localStorage.setItem(STORAGE_KEY, configStr);
  } catch {
    // localStorage may be unavailable (private browsing, quota exceeded)
  }
}

/**
 * Convert current configuration to RUST_LOG-style string.
 */
function configToString(): string {
  const parts = [`${currentConfig.defaultLevel}`];
  for (const [module, level] of currentConfig.moduleOverrides) {
    parts.push(`${module}=${level}`);
  }
  return parts.join(",");
}

/**
 * Load configuration from localStorage.
 * @returns Configuration string or null if not found
 */
function loadConfigFromStorage(): string | null {
  if (typeof localStorage === "undefined") return null;

  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Read configuration from URL parameters and remove it from the URL.
 * This makes ?logLevel=... a one-shot bootstrap override.
 *
 * @returns Configuration string or null if not found
 */
function consumeConfigFromUrl(): string | null {
  if (typeof window === "undefined" || !window.location) return null;

  try {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const hasParam = params.has(URL_PARAM);
    const config = params.get(URL_PARAM);

    if (hasParam) {
      params.delete(URL_PARAM);
      const newUrl =
        url.pathname +
        (params.toString() ? `?${params.toString()}` : "") +
        url.hash;
      window.history.replaceState({}, "", newUrl);
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * Clear persisted log configuration from localStorage.
 */
function clearPersistedConfig(): void {
  if (typeof localStorage === "undefined") return;

  try {
    localStorage.removeItem(STORAGE_KEY);
    console.info("[logger] Cleared persisted configuration");
  } catch {
    // Ignore errors
  }
}

/**
 * Initialize the logging system.
 *
 * Priority order:
 * 1. URL parameter (?logLevel=...) - one-shot startup override, not persisted
 * 2. localStorage - persisted configuration
 * 3. Build default (debug in dev builds, info otherwise)
 *
 * This function is called automatically on module load.
 */
function initializeLogging(): void {
  // URL parameter is a one-shot startup override (useful for debugging).
  // Don't persist URL config - it's ephemeral.
  const urlConfig = consumeConfigFromUrl();
  if (urlConfig) {
    configure(urlConfig, false);
    console.info(`[logger] Initialized from URL: ${urlConfig}`);
    return;
  }

  // Try localStorage - don't re-persist what we just loaded
  const storedConfig = loadConfigFromStorage();
  if (storedConfig) {
    configure(storedConfig, false);
    console.info(`[logger] Initialized from localStorage: ${storedConfig}`);
    return;
  }

  currentConfig.defaultLevel = DEFAULT_LOG_LEVEL;
  console.info(
    `[logger] Initialized with default config (${DEFAULT_LOG_LEVEL})`,
  );
}

/**
 * Dev console API - exposed on window for runtime configuration.
 */
interface NightfallLogApi {
  /**
   * Configure logging with RUST_LOG-style string.
   * @example nightfallLog.configure('warn,websocket=debug')
   */
  configure: (config: string) => void;

  /**
   * Get current configuration.
   */
  getConfig: () => {
    defaultLevel: LogLevel;
    moduleOverrides: Record<string, LogLevel>;
  };

  /**
   * Set the global (default) log level.
   */
  setGlobalLevel: (level: LogLevel) => void;

  /**
   * Set the log level for a specific module.
   */
  setModuleLevel: (module: string, level: LogLevel | null) => void;

  /**
   * List all registered modules and their effective levels.
   */
  listModules: () => Record<string, LogLevel>;

  /**
   * Clear the persisted configuration from localStorage.
   */
  clearPersistedConfig: () => void;

  /**
   * Available log levels for reference.
   */
  levels: readonly LogLevel[];
}

// Expose on window for dev console access
declare global {
  interface Window {
    nightfallLog: NightfallLogApi;
  }
}

if (typeof window !== "undefined") {
  window.nightfallLog = {
    configure,
    getConfig,
    setGlobalLevel: setGlobalLogLevel,
    setModuleLevel: setModuleLogLevel,
    listModules,
    levels: Object.values(LogLevel),
    clearPersistedConfig: clearPersistedConfig,
  };

  // Initialize logging on module load
  initializeLogging();
}
