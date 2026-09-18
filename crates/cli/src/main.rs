// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Standalone CLI binary that connects to the nightfall engine via WebSocket
//!
//! This binary provides an interactive terminal interface using reedline for users
//! to execute lighting commands. It communicates with the nightfall engine via WebSocket,
//! sending commands and receiving results.

use std::collections::HashMap;
use std::io::IsTerminal;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use itertools::Itertools;
use nightfall_cmd_parse::split_command_statements;
use nightfall_config::{RuntimeConfig, RuntimeConfigLoader};
use reedline::{DefaultPrompt, DefaultPromptSegment, Reedline, Signal};
use serde_json::json;
use tokio::sync::{Mutex, oneshot};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message as WsMessage, protocol::WebSocketConfig},
};
use uuid::Uuid;

const CLI_WEBSOCKET_MAX_PAYLOAD_SIZE: usize = 64 << 20;

/// Startup errors that can be reported by the CLI entrypoint.
#[derive(thiserror::Error, Debug)]
enum CliError {
    #[error("WebSocket error: {0}")]
    WebSocket(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Command failed: {0}")]
    CommandFailed(String),
}

type WebsocketStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Builds the WebSocket protocol limits used by the standalone CLI.
fn cli_websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(CLI_WEBSOCKET_MAX_PAYLOAD_SIZE))
        .max_frame_size(Some(CLI_WEBSOCKET_MAX_PAYLOAD_SIZE))
}

/// Runtime state for the interactive CLI's engine WebSocket session.
struct CliApp {
    ws_url: String,
    ws_sender: Arc<Mutex<Option<futures_util::stream::SplitSink<WebsocketStream, WsMessage>>>>,
    is_connected: Arc<std::sync::atomic::AtomicBool>,
    pending_results: Arc<Mutex<HashMap<Uuid, oneshot::Sender<Result<(), String>>>>>,
}

impl CliApp {
    /// Creates a disconnected CLI session for one engine WebSocket URL.
    fn new(ws_url: String) -> Self {
        Self {
            ws_url,
            ws_sender: Arc::new(Mutex::new(None)),
            is_connected: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            pending_results: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Connects the WebSocket and starts terminal-result delivery for submitted commands.
    async fn connect(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        tracing::debug!("Connecting to engine at {}", self.ws_url);

        let (ws_stream, _) =
            connect_async_with_config(&self.ws_url, Some(cli_websocket_config()), false)
                .await
                .map_err(|e| {
                    Box::new(CliError::WebSocket(e.to_string())) as Box<dyn std::error::Error>
                })?;

        tracing::debug!("Connected to engine");
        let (sender, mut receiver) = ws_stream.split();

        *self.ws_sender.lock().await = Some(sender);
        self.is_connected
            .store(true, std::sync::atomic::Ordering::SeqCst);

        // Spawn background task to monitor connection
        let is_connected = self.is_connected.clone();
        let pending_results = self.pending_results.clone();
        tokio::spawn(async move {
            loop {
                match receiver.next().await {
                    Some(Ok(WsMessage::Binary(bytes))) => {
                        if let Some((command_id, outcome)) = decode_command_result_message(&bytes)
                            && let Some(waiter) = pending_results.lock().await.remove(&command_id)
                        {
                            let _ = waiter.send(outcome);
                        }
                    }
                    Some(Ok(WsMessage::Text(text))) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
                            && let Some((command_id, outcome)) = decode_command_result_value(&value)
                            && let Some(waiter) = pending_results.lock().await.remove(&command_id)
                        {
                            let _ = waiter.send(outcome);
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => {
                        tracing::info!("Server closed connection");
                        is_connected.store(false, std::sync::atomic::Ordering::SeqCst);
                        fail_pending_results(&pending_results, "Connection closed").await;
                        break;
                    }
                    Some(Err(e)) => {
                        tracing::warn!("WebSocket error: {}", e);
                        is_connected.store(false, std::sync::atomic::Ordering::SeqCst);
                        fail_pending_results(&pending_results, e.to_string()).await;
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }

    /// Splits one input into independent commands and awaits each terminal result in order.
    async fn send_command_string(&mut self, input: &str) -> Result<(), Box<dyn std::error::Error>> {
        for statement in split_command_statements(input) {
            let command_id = Uuid::new_v4();
            let command_json = create_eval_command_json(command_id, command_id, &statement)?;
            let (result_sender, result_receiver) = oneshot::channel();
            self.pending_results
                .lock()
                .await
                .insert(command_id, result_sender);

            if let Err(error) = self.send_command_json(&command_json).await {
                self.pending_results.lock().await.remove(&command_id);
                return Err(error);
            }

            match result_receiver.await {
                Ok(Ok(())) => {}
                Ok(Err(message)) => return Err(Box::new(CliError::CommandFailed(message))),
                Err(_) => {
                    return Err(Box::new(CliError::WebSocket(
                        "Command result channel closed".to_string(),
                    )));
                }
            }
        }
        Ok(())
    }

    /// Sends one already serialized command envelope to the connected engine.
    async fn send_command_json(
        &mut self,
        command_json: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut sender = self.ws_sender.lock().await;
        if let Some(ws_sender) = sender.as_mut() {
            tracing::debug!("Sending WebSocket message: {}", command_json);
            ws_sender
                .send(WsMessage::Text(command_json.into()))
                .await
                .map_err(|e| {
                    Box::new(CliError::WebSocket(e.to_string())) as Box<dyn std::error::Error>
                })
        } else {
            Err(Box::new(CliError::WebSocket("Not connected".to_string()))
                as Box<dyn std::error::Error>)
        }
    }

    /// Runs stdin or interactive terminal command processing until exit or disconnection.
    async fn run_interactive(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if !std::io::stdin().is_terminal() {
            let input = std::io::stdin().lines().map_while(Result::ok).join("");
            self.send_command_string(&input).await?;
            tracing::warn!("read commands from stdin; no further commands will be parsed");
            return Ok(());
        }

        let mut line_editor = Reedline::create();
        let prompt = DefaultPrompt::new(DefaultPromptSegment::Empty, DefaultPromptSegment::Empty);
        let is_connected = self.is_connected.clone();

        loop {
            // Check connection status before reading
            if !is_connected.load(std::sync::atomic::Ordering::SeqCst) {
                eprintln!("Connection lost");
                return Err(Box::new(CliError::WebSocket("Connection lost".to_string()))
                    as Box<dyn std::error::Error>);
            }

            match line_editor.read_line(&prompt) {
                Ok(Signal::Success(input)) => {
                    if !input.is_empty() {
                        if let Err(error) = self.send_command_string(&input).await {
                            if is_command_failure(error.as_ref()) {
                                eprintln!("{error}");
                                continue;
                            }
                            return Err(error);
                        }
                    }
                }
                Ok(Signal::CtrlC) | Ok(Signal::CtrlD) => {
                    // User wants to exit
                    return Ok(());
                }
                Ok(_) => {
                    continue;
                }
                Err(e) => {
                    return Err(
                        Box::new(CliError::WebSocket(e.to_string())) as Box<dyn std::error::Error>
                    );
                }
            }
        }
    }
}

/// Returns whether an error is a semantic command rejection rather than transport loss.
fn is_command_failure(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<CliError>()
        .is_some_and(|error| matches!(error, CliError::CommandFailed(_)))
}

/// Fails every command waiter when the WebSocket can no longer deliver results.
async fn fail_pending_results(
    pending_results: &Mutex<HashMap<Uuid, oneshot::Sender<Result<(), String>>>>,
    message: impl Into<String>,
) {
    let message = message.into();
    let waiters = pending_results
        .lock()
        .await
        .drain()
        .map(|(_, waiter)| waiter)
        .collect::<Vec<_>>();
    for waiter in waiters {
        let _ = waiter.send(Err(message.clone()));
    }
}

/// Decodes a binary engine WebSocket message when it contains a command result.
fn decode_command_result_message(bytes: &[u8]) -> Option<(Uuid, Result<(), String>)> {
    let payload = bytes.get(1..)?;
    let value: serde_json::Value = minicbor_serde::from_slice(payload).ok()?;
    decode_command_result_value(&value)
}

/// Extracts a command identity and success/failure from a decoded engine message.
fn decode_command_result_value(value: &serde_json::Value) -> Option<(Uuid, Result<(), String>)> {
    if value.get("type")?.as_str()? != "CommandResult" {
        return None;
    }
    let data = value.get("data")?;
    let command_id = Uuid::parse_str(data.get("command_id")?.as_str()?).ok()?;
    let outcome = data.get("outcome")?;
    let result = match outcome.get("type")?.as_str()? {
        "Succeeded" => Ok(()),
        "Failed" => Err(outcome.get("data")?.get("message")?.as_str()?.to_string()),
        _ => return None,
    };
    Some((command_id, result))
}

/// Create a DeskCommand::Eval JSON envelope for the given command string.
///
/// The server will parse the command string and dispatch it to the appropriate module
/// (Programmer, Cues, Timecode, etc.) based on the AST.
fn create_eval_command_json(
    command_id: Uuid,
    undo_id: Uuid,
    command_str: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let envelope = json!({
        "command_id": command_id.to_string(),
        "undo_id": undo_id.to_string(),
        "module": "DeskCommand",
        "command": {
            "type": "Eval",
            "data": command_str
        }
    });

    Ok(serde_json::to_string(&envelope)?)
}

/// Loads process configuration before starting the asynchronous CLI runtime.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime_config = RuntimeConfigLoader::new().load()?;

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(runtime_config))
}

/// Connects to the backend and runs the interactive CLI session.
async fn run(runtime_config: RuntimeConfig) -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    let filter = tracing_subscriber::EnvFilter::try_new(
        runtime_config.log_filter.as_deref().unwrap_or("info"),
    )?
    .add_directive(tracing_subscriber::filter::LevelFilter::INFO.into());

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(std::io::stderr().is_terminal())
        .init();

    let mut app = CliApp::new(runtime_config.websocket_url);

    // Connect to the server
    app.connect().await?;

    app.run_interactive().await?;

    tracing::info!("CLI exiting");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies the CLI accepts backend snapshots up to the websocket message cap.
    #[test]
    fn cli_websocket_config_raises_frame_limit_to_message_limit() {
        let config = cli_websocket_config();

        assert_eq!(
            config.max_message_size,
            Some(CLI_WEBSOCKET_MAX_PAYLOAD_SIZE)
        );
        assert_eq!(config.max_frame_size, Some(CLI_WEBSOCKET_MAX_PAYLOAD_SIZE));
    }

    /// Verifies CLI envelopes use the semantic command and undo wire fields.
    #[test]
    fn eval_envelope_uses_command_identity() {
        let command_id = Uuid::new_v4();
        let encoded = create_eval_command_json(command_id, command_id, "clear").unwrap();
        let envelope: serde_json::Value = serde_json::from_str(&encoded).unwrap();

        assert_eq!(envelope["command_id"], command_id.to_string());
        assert_eq!(envelope["undo_id"], command_id.to_string());
        assert!(envelope.get("correlation_id").is_none());
    }

    /// Verifies CLI sequencing preserves semicolons embedded in quoted arguments.
    #[test]
    fn command_sequence_splits_only_unquoted_semicolons() {
        assert_eq!(
            split_command_statements("fix 1 \"custom;attr\" @ 10; store cue 1.1"),
            vec!["fix 1 \"custom;attr\" @ 10", "store cue 1.1"]
        );
    }

    /// Verifies binary command failures retain their identity and operator message.
    #[test]
    fn command_result_decoder_reads_binary_failure() {
        let command_id = Uuid::new_v4();
        let value = json!({
            "type": "CommandResult",
            "data": {
                "command_id": command_id,
                "outcome": {
                    "type": "Failed",
                    "data": { "code": "test.failed", "message": "Nope" }
                }
            }
        });
        let mut bytes = vec![0];
        bytes.extend(minicbor_serde::to_vec(&value).unwrap());

        assert_eq!(
            decode_command_result_message(&bytes),
            Some((command_id, Err("Nope".to_string())))
        );
    }

    /// Verifies semantic failures can be reported without ending an interactive session.
    #[test]
    fn command_failure_is_distinct_from_transport_failure() {
        let command_error = CliError::CommandFailed("invalid command".to_string());
        let transport_error = CliError::WebSocket("disconnected".to_string());

        assert!(is_command_failure(&command_error));
        assert!(!is_command_failure(&transport_error));
    }
}
