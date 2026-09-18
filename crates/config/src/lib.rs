// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Typed, non-mutating startup configuration for Nightfall processes.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};

use thiserror::Error;

/// Default port used by the backend HTTP and WebSocket server.
pub const DEFAULT_SERVER_PORT: u16 = 3030;
/// Offset from the backend port used by the OSC listener.
pub const OSC_PORT_OFFSET: u16 = 2;
/// Default OSC port used when adding [`OSC_PORT_OFFSET`] would overflow.
pub const DEFAULT_OSC_PORT: u16 = DEFAULT_SERVER_PORT + OSC_PORT_OFFSET;
/// Default graceful-shutdown window before the process aborts.
pub const DEFAULT_FATAL_SHUTDOWN_GRACE: Duration = Duration::from_millis(1500);

const DATA_DIR_ENV: &str = "NIGHTFALL_DATA_DIR";
const SERVER_PORT_ENV: &str = "NIGHTFALL_PORT";
const WEBSOCKET_URL_ENV: &str = "NIGHTFALL_WS_URL";
const OSC_BIND_ENV: &str = "NIGHTFALL_OSC_BIND";
const OSC_PORT_ENV: &str = "NIGHTFALL_OSC_PORT";
const INPUT_SACN_ENABLED_ENV: &str = "NIGHTFALL_INPUT_SACN_ENABLED";
const OUTPUT_SACN_ENABLED_ENV: &str = "NIGHTFALL_OUTPUT_SACN_ENABLED";
const OUTPUT_ARTNET_ENABLED_ENV: &str = "NIGHTFALL_OUTPUT_ARTNET";
const INPUT_ARTNET_ENABLED_ENV: &str = "NIGHTFALL_INPUT_ARTNET";
const OUTPUT_USB_ENABLED_ENV: &str = "NIGHTFALL_OUTPUT_USB";
const SAMPLE_DATA_ENV: &str = "NIGHTFALL_SAMPLE_DATA";
const STARTUP_COMMANDS_ENV: &str = "NIGHTFALL_STARTUP_CMDS";
const EXPERIMENTAL_FLOWS_ENV: &str = "NIGHTFALL_EXPERIMENTAL_FLOWS";
const TIMELINE_AUDIO_ENABLED_ENV: &str = "NIGHTFALL_TIMELINE_AUDIO_ENABLED";
const FATAL_SHUTDOWN_GRACE_ENV: &str = "NIGHTFALL_FATAL_SHUTDOWN_GRACE_MS";
const DISABLE_WATCHDOG_ENV: &str = "NIGHTFALL_DISABLE_FATAL_SHUTDOWN_WATCHDOG";
const RUST_LOG_ENV: &str = "RUST_LOG";

/// Fully resolved startup configuration consumed by Nightfall binaries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeConfig {
    /// Bundled resource directory supplied by the desktop host, never by a showfile.
    pub resource_dir: Option<PathBuf>,
    /// Optional application data-directory override.
    pub data_dir: Option<PathBuf>,
    /// Port used by the backend HTTP and WebSocket server.
    pub server_port: u16,
    /// URL used by standalone clients to connect to the backend.
    pub websocket_url: String,
    /// Address used by the OSC input listener.
    pub osc_bind_addr: SocketAddr,
    /// Startup permissions for physical and network transports.
    pub transports: TransportConfig,
    /// Options controlling the initial backend world and commands.
    pub startup: StartupConfig,
    /// Whether timeline audio output is enabled process-wide.
    pub timeline_audio_enabled: bool,
    /// Whether incomplete flow authoring and execution are explicitly enabled.
    pub experimental_flows: bool,
    /// Fatal process-shutdown behavior.
    pub shutdown: ShutdownConfig,
    /// Optional tracing filter sourced from `RUST_LOG`.
    pub log_filter: Option<String>,
}

impl Default for RuntimeConfig {
    /// Builds configuration using application defaults without reading external sources.
    fn default() -> Self {
        Self::from_layer(ConfigLayer::default())
    }
}

impl RuntimeConfig {
    /// Resolves typed configuration from string key-value pairs and explicit overrides.
    ///
    /// Values typically come from a merged dotenv/process-environment map. Overrides are
    /// applied afterward so a future CLI parser can take precedence without changing the
    /// configuration consumers.
    pub fn from_values<K, V, I>(
        values: I,
        overrides: RuntimeConfigOverrides,
    ) -> Result<Self, ConfigError>
    where
        K: Into<String>,
        V: Into<String>,
        I: IntoIterator<Item = (K, V)>,
    {
        let values = values
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect::<HashMap<_, _>>();
        let mut layer = ConfigLayer::from_values(&values)?;
        layer.apply_overrides(overrides);
        Ok(Self::from_layer(layer))
    }

    /// Finalizes defaults and derived values after all configuration layers are merged.
    fn from_layer(layer: ConfigLayer) -> Self {
        let server_port = layer.server_port.unwrap_or(DEFAULT_SERVER_PORT);
        let websocket_url = layer
            .websocket_url
            .unwrap_or_else(|| format!("ws://localhost:{server_port}/ws"));
        let osc_bind_addr = layer.osc_bind_addr.unwrap_or_else(|| {
            let port = layer
                .osc_port
                .unwrap_or_else(|| default_osc_port(server_port));
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port)
        });

        Self {
            resource_dir: None,
            data_dir: layer.data_dir,
            server_port,
            websocket_url,
            osc_bind_addr,
            transports: TransportConfig {
                network_input_enabled: layer.network_input_enabled.unwrap_or(true),
                network_output_enabled: layer.network_output_enabled.unwrap_or(true),
                usb_output_enabled: layer.usb_output_enabled.unwrap_or(true),
            },
            startup: StartupConfig {
                sample_data: layer.sample_data.unwrap_or(false),
                commands: normalize_optional_string(layer.startup_commands),
            },
            timeline_audio_enabled: layer.timeline_audio_enabled.unwrap_or(true),
            experimental_flows: layer.experimental_flows.unwrap_or(false),
            shutdown: ShutdownConfig {
                grace_period: layer
                    .fatal_shutdown_grace
                    .unwrap_or(DEFAULT_FATAL_SHUTDOWN_GRACE),
                watchdog_disabled: layer.watchdog_disabled.unwrap_or(false),
            },
            log_filter: normalize_optional_string(layer.log_filter),
        }
    }
}

/// Startup permissions shared by the runtime transport plugins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportConfig {
    /// Whether network input plugins may receive data at startup.
    pub network_input_enabled: bool,
    /// Whether network output plugins may transmit data at startup.
    pub network_output_enabled: bool,
    /// Whether USB output plugins may transmit data at startup.
    pub usb_output_enabled: bool,
}

/// Options controlling the initial backend world and command queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupConfig {
    /// Whether startup should seed the sample show instead of an empty show.
    pub sample_data: bool,
    /// Optional command string queued after the backend world is built.
    pub commands: Option<String>,
}

/// Fatal process-shutdown settings resolved before worker threads start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShutdownConfig {
    /// Grace period allowed for backend shutdown before aborting.
    pub grace_period: Duration,
    /// Whether the forced-abort watchdog is disabled.
    pub watchdog_disabled: bool,
}

/// Highest-precedence typed values, intended for CLI arguments or embedding applications.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuntimeConfigOverrides {
    /// Overrides the application data directory when present.
    pub data_dir: Option<PathBuf>,
    /// Overrides the backend HTTP and WebSocket port when present.
    pub server_port: Option<u16>,
    /// Overrides the standalone client WebSocket URL when present.
    pub websocket_url: Option<String>,
    /// Overrides the OSC listener address when present.
    pub osc_bind_addr: Option<SocketAddr>,
    /// Overrides startup network input permission when present.
    pub network_input_enabled: Option<bool>,
    /// Overrides startup network output permission when present.
    pub network_output_enabled: Option<bool>,
    /// Overrides startup USB output permission when present.
    pub usb_output_enabled: Option<bool>,
    /// Overrides sample-data seeding when present.
    pub sample_data: Option<bool>,
    /// Overrides the startup command string when present.
    pub startup_commands: Option<String>,
    /// Overrides timeline audio output when present.
    pub timeline_audio_enabled: Option<bool>,
    /// Overrides the experimental flow feature when present.
    pub experimental_flows: Option<bool>,
    /// Overrides the fatal shutdown grace period when present.
    pub fatal_shutdown_grace: Option<Duration>,
    /// Overrides fatal shutdown watchdog behavior when present.
    pub watchdog_disabled: Option<bool>,
    /// Overrides the tracing filter when present.
    pub log_filter: Option<String>,
}

/// Loads dotenv and inherited environment values without modifying the process environment.
#[derive(Debug, Clone)]
pub struct RuntimeConfigLoader {
    dotenv_path: PathBuf,
    fallback_dotenv_path: Option<PathBuf>,
    overrides: RuntimeConfigOverrides,
}

impl Default for RuntimeConfigLoader {
    /// Builds a loader for an optional `.env` file in the current directory.
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeConfigLoader {
    /// Builds a loader for an optional `.env` file in the current directory.
    #[must_use]
    pub fn new() -> Self {
        Self {
            dotenv_path: PathBuf::from(".env"),
            fallback_dotenv_path: None,
            overrides: RuntimeConfigOverrides::default(),
        }
    }

    /// Uses the supplied dotenv path as the primary file source.
    #[must_use]
    pub fn dotenv_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.dotenv_path = path.into();
        self
    }

    /// Uses the supplied path only when the primary dotenv file does not exist.
    #[must_use]
    pub fn fallback_dotenv_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.fallback_dotenv_path = Some(path.into());
        self
    }

    /// Applies typed values after dotenv and inherited environment values.
    #[must_use]
    pub fn overrides(mut self, overrides: RuntimeConfigOverrides) -> Self {
        self.overrides = overrides;
        self
    }

    /// Loads and resolves the configuration without modifying process-global state.
    pub fn load(self) -> Result<RuntimeConfig, ConfigError> {
        let dotenv_path = self.selected_dotenv_path();
        let values = dotenv::EnvLoader::with_path(dotenv_path)
            .required(false)
            .substitution(true)
            .load()?;
        RuntimeConfig::from_values(values, self.overrides)
    }

    /// Chooses the primary dotenv path when it exists and otherwise uses the fallback.
    fn selected_dotenv_path(&self) -> &Path {
        if self.dotenv_path.is_file() {
            &self.dotenv_path
        } else {
            self.fallback_dotenv_path
                .as_deref()
                .unwrap_or(&self.dotenv_path)
        }
    }
}

/// Errors returned while loading or parsing typed startup configuration.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// The selected dotenv file or inherited process environment could not be read.
    #[error("failed to load startup environment: {0}")]
    Load(#[from] dotenv::Error),
    /// A recognized configuration variable contained an invalid typed value.
    #[error("invalid {variable} value {value:?}; expected {expected}")]
    InvalidValue {
        /// Name of the invalid configuration variable.
        variable: &'static str,
        /// Original value supplied by the configuration source.
        value: String,
        /// Human-readable description of accepted values.
        expected: &'static str,
    },
}

/// Partially resolved values before defaults and derived settings are applied.
#[derive(Debug, Default)]
struct ConfigLayer {
    data_dir: Option<PathBuf>,
    server_port: Option<u16>,
    websocket_url: Option<String>,
    osc_bind_addr: Option<SocketAddr>,
    osc_port: Option<u16>,
    network_input_enabled: Option<bool>,
    network_output_enabled: Option<bool>,
    usb_output_enabled: Option<bool>,
    sample_data: Option<bool>,
    startup_commands: Option<String>,
    timeline_audio_enabled: Option<bool>,
    experimental_flows: Option<bool>,
    fatal_shutdown_grace: Option<Duration>,
    watchdog_disabled: Option<bool>,
    log_filter: Option<String>,
}

impl ConfigLayer {
    /// Parses all recognized environment variables into a partial typed layer.
    fn from_values(values: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let input_sacn = parse_optional_bool(values, INPUT_SACN_ENABLED_ENV)?;
        let input_artnet = parse_optional_bool(values, INPUT_ARTNET_ENABLED_ENV)?;
        let output_sacn = parse_optional_bool(values, OUTPUT_SACN_ENABLED_ENV)?;
        let output_artnet = parse_optional_bool(values, OUTPUT_ARTNET_ENABLED_ENV)?;

        Ok(Self {
            data_dir: optional_string(values, DATA_DIR_ENV).map(PathBuf::from),
            server_port: parse_optional(values, SERVER_PORT_ENV, "a port from 0 to 65535")?,
            websocket_url: optional_string(values, WEBSOCKET_URL_ENV),
            osc_bind_addr: parse_optional(values, OSC_BIND_ENV, "an IP socket address")?,
            osc_port: parse_optional(values, OSC_PORT_ENV, "a port from 0 to 65535")?,
            network_input_enabled: merge_transport_values(input_sacn, input_artnet),
            network_output_enabled: merge_transport_values(output_sacn, output_artnet),
            usb_output_enabled: parse_optional_bool(values, OUTPUT_USB_ENABLED_ENV)?,
            sample_data: parse_optional_bool(values, SAMPLE_DATA_ENV)?,
            startup_commands: optional_string(values, STARTUP_COMMANDS_ENV),
            timeline_audio_enabled: parse_optional_bool(values, TIMELINE_AUDIO_ENABLED_ENV)?,
            experimental_flows: parse_optional_bool(values, EXPERIMENTAL_FLOWS_ENV)?,
            fatal_shutdown_grace: parse_optional::<u64>(
                values,
                FATAL_SHUTDOWN_GRACE_ENV,
                "a non-negative millisecond count",
            )?
            .map(Duration::from_millis),
            watchdog_disabled: parse_optional_bool(values, DISABLE_WATCHDOG_ENV)?,
            log_filter: optional_string(values, RUST_LOG_ENV),
        })
    }

    /// Applies highest-precedence typed overrides to this partial layer.
    fn apply_overrides(&mut self, overrides: RuntimeConfigOverrides) {
        apply_override(&mut self.experimental_flows, overrides.experimental_flows);
        apply_override(&mut self.data_dir, overrides.data_dir);
        apply_override(&mut self.server_port, overrides.server_port);
        apply_override(&mut self.websocket_url, overrides.websocket_url);
        apply_override(&mut self.osc_bind_addr, overrides.osc_bind_addr);
        apply_override(
            &mut self.network_input_enabled,
            overrides.network_input_enabled,
        );
        apply_override(
            &mut self.network_output_enabled,
            overrides.network_output_enabled,
        );
        apply_override(&mut self.usb_output_enabled, overrides.usb_output_enabled);
        apply_override(&mut self.sample_data, overrides.sample_data);
        apply_override(&mut self.startup_commands, overrides.startup_commands);
        apply_override(
            &mut self.timeline_audio_enabled,
            overrides.timeline_audio_enabled,
        );
        apply_override(
            &mut self.fatal_shutdown_grace,
            overrides.fatal_shutdown_grace,
        );
        apply_override(&mut self.watchdog_disabled, overrides.watchdog_disabled);
        apply_override(&mut self.log_filter, overrides.log_filter);
    }
}

/// Replaces a lower-precedence optional value when an override is present.
fn apply_override<T>(target: &mut Option<T>, value: Option<T>) {
    if value.is_some() {
        *target = value;
    }
}

/// Reads a trimmed non-empty string from a configuration map.
fn optional_string(values: &HashMap<String, String>, variable: &'static str) -> Option<String> {
    normalize_optional_string(values.get(variable).cloned())
}

/// Trims an optional string and removes blank values.
fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// Parses one optional configuration value using its standard string representation.
fn parse_optional<T>(
    values: &HashMap<String, String>,
    variable: &'static str,
    expected: &'static str,
) -> Result<Option<T>, ConfigError>
where
    T: std::str::FromStr,
{
    let Some(value) = optional_string(values, variable) else {
        return Ok(None);
    };
    value
        .parse::<T>()
        .map(Some)
        .map_err(|_| ConfigError::InvalidValue {
            variable,
            value,
            expected,
        })
}

/// Parses one optional boolean using the accepted Nightfall environment spellings.
fn parse_optional_bool(
    values: &HashMap<String, String>,
    variable: &'static str,
) -> Result<Option<bool>, ConfigError> {
    let Some(value) = optional_string(values, variable) else {
        return Ok(None);
    };
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(Some(true)),
        "0" | "false" | "no" | "off" => Ok(Some(false)),
        _ => Err(ConfigError::InvalidValue {
            variable,
            value,
            expected: "one of 1, 0, true, false, yes, no, on, or off",
        }),
    }
}

/// Combines per-protocol transport settings, choosing disabled on conflicts.
fn merge_transport_values(first: Option<bool>, second: Option<bool>) -> Option<bool> {
    match (first, second) {
        (Some(first), Some(second)) => Some(first && second),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

/// Derives the OSC listener port from the backend port with an overflow fallback.
fn default_osc_port(server_port: u16) -> u16 {
    server_port
        .checked_add(OSC_PORT_OFFSET)
        .unwrap_or(DEFAULT_OSC_PORT)
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs, net::SocketAddr, time::Duration};

    use super::*;

    /// Verifies source-free configuration uses stable application defaults.
    #[test]
    fn defaults_are_fully_resolved() {
        let config = RuntimeConfig::default();

        assert_eq!(config.server_port, DEFAULT_SERVER_PORT);
        assert_eq!(config.websocket_url, "ws://localhost:3030/ws");
        assert_eq!(config.osc_bind_addr, "0.0.0.0:3032".parse().unwrap());
        assert!(config.transports.network_input_enabled);
        assert!(config.transports.network_output_enabled);
        assert!(config.transports.usb_output_enabled);
        assert!(!config.startup.sample_data);
        assert_eq!(config.startup.commands, None);
        assert!(config.timeline_audio_enabled);
        assert!(!config.experimental_flows);
        assert_eq!(config.shutdown.grace_period, Duration::from_millis(1500));
        assert!(!config.shutdown.watchdog_disabled);
    }

    /// Verifies explicit experimental opt-in and rejects malformed flag values.
    #[test]
    fn experimental_flows_require_explicit_valid_opt_in() {
        let enabled =
            RuntimeConfig::from_values([(EXPERIMENTAL_FLOWS_ENV, "1")], Default::default())
                .unwrap();
        assert!(enabled.experimental_flows);
        let disabled =
            RuntimeConfig::from_values([(EXPERIMENTAL_FLOWS_ENV, "0")], Default::default())
                .unwrap();
        assert!(!disabled.experimental_flows);
        assert!(
            RuntimeConfig::from_values([(EXPERIMENTAL_FLOWS_ENV, "maybe")], Default::default())
                .is_err()
        );
    }

    /// Verifies environment-shaped values parse into concrete configuration types.
    #[test]
    fn values_resolve_typed_runtime_configuration() {
        let values = HashMap::from([
            (DATA_DIR_ENV, "/tmp/nightfall"),
            (SERVER_PORT_ENV, "4100"),
            (OSC_PORT_ENV, "4200"),
            (INPUT_SACN_ENABLED_ENV, "true"),
            (INPUT_ARTNET_ENABLED_ENV, "false"),
            (OUTPUT_USB_ENABLED_ENV, "off"),
            (SAMPLE_DATA_ENV, "yes"),
            (STARTUP_COMMANDS_ENV, "  clear  "),
            (TIMELINE_AUDIO_ENABLED_ENV, "0"),
            (FATAL_SHUTDOWN_GRACE_ENV, "2500"),
            (DISABLE_WATCHDOG_ENV, "1"),
            (RUST_LOG_ENV, "debug,nightfall=trace"),
        ]);

        let config = RuntimeConfig::from_values(values, RuntimeConfigOverrides::default()).unwrap();

        assert_eq!(config.data_dir, Some(PathBuf::from("/tmp/nightfall")));
        assert_eq!(config.server_port, 4100);
        assert_eq!(config.websocket_url, "ws://localhost:4100/ws");
        assert_eq!(config.osc_bind_addr, "0.0.0.0:4200".parse().unwrap());
        assert!(!config.transports.network_input_enabled);
        assert!(!config.transports.usb_output_enabled);
        assert!(config.startup.sample_data);
        assert_eq!(config.startup.commands.as_deref(), Some("clear"));
        assert!(!config.timeline_audio_enabled);
        assert_eq!(config.shutdown.grace_period, Duration::from_millis(2500));
        assert!(config.shutdown.watchdog_disabled);
        assert_eq!(config.log_filter.as_deref(), Some("debug,nightfall=trace"));
    }

    /// Verifies typed overrides win before dependent defaults are derived.
    #[test]
    fn overrides_take_precedence_before_derivation() {
        let overrides = RuntimeConfigOverrides {
            server_port: Some(5100),
            osc_bind_addr: Some("127.0.0.1:5200".parse::<SocketAddr>().unwrap()),
            network_output_enabled: Some(false),
            ..Default::default()
        };

        let config = RuntimeConfig::from_values(
            [(SERVER_PORT_ENV, "4100"), (OUTPUT_USB_ENABLED_ENV, "true")],
            overrides,
        )
        .unwrap();

        assert_eq!(config.server_port, 5100);
        assert_eq!(config.websocket_url, "ws://localhost:5100/ws");
        assert_eq!(config.osc_bind_addr, "127.0.0.1:5200".parse().unwrap());
        assert!(!config.transports.network_output_enabled);
    }

    /// Verifies malformed recognized values fail with the responsible variable name.
    #[test]
    fn invalid_typed_value_is_rejected() {
        let error = RuntimeConfig::from_values(
            [(SERVER_PORT_ENV, "not-a-port")],
            RuntimeConfigOverrides::default(),
        )
        .unwrap_err();

        assert!(error.to_string().contains(SERVER_PORT_ENV));
    }

    /// Verifies dotenv loading reads values without writing them into the process environment.
    #[test]
    fn dotenv_loading_does_not_modify_process_environment() {
        const SENTINEL: &str = "NIGHTFALL_CONFIG_NONMUTATION_SENTINEL";
        let original = std::env::var_os(SENTINEL);
        let temp_dir = tempfile::tempdir().unwrap();
        let dotenv_path = temp_dir.path().join("runtime.env");
        fs::write(&dotenv_path, format!("{SENTINEL}=from-dotenv\n")).unwrap();

        RuntimeConfigLoader::new()
            .dotenv_path(dotenv_path)
            .load()
            .unwrap();

        assert_eq!(std::env::var_os(SENTINEL), original);
    }

    /// Verifies a fallback dotenv file is used only when the primary path is absent.
    #[test]
    fn loader_uses_fallback_for_missing_primary_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let fallback = temp_dir.path().join("fallback.env");
        fs::write(&fallback, format!("{SERVER_PORT_ENV}=4300\n")).unwrap();

        let config = RuntimeConfigLoader::new()
            .dotenv_path(temp_dir.path().join("missing.env"))
            .fallback_dotenv_path(fallback)
            .load()
            .unwrap();

        assert_eq!(config.server_port, 4300);
    }
}
