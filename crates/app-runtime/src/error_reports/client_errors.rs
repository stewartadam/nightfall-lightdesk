// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Uncaught web UI errors forwarded through the engine, so browsers and LAN devices without
//! internet access share the engine's consent check and offline queue.

use axum::{Json, http::StatusCode, routing::post};
use nightfall_websocket::prelude::HttpRouteRegistry;
use sentry::protocol::{Event, Exception, Frame, Level, Mechanism, Stacktrace};

/// Longest error message kept from a client report.
const MAX_MESSAGE_CHARS: usize = 2_000;
/// Longest error name kept from a client report.
const MAX_NAME_CHARS: usize = 200;
/// Most stack frames kept from a client report.
const MAX_FRAMES: usize = 64;

/// Registers the endpoint the web UI posts uncaught errors to. Like every `/api` route it is
/// limited to the engine machine and paired devices.
pub(crate) fn register_routes(registry: &mut HttpRouteRegistry) {
    registry.register("/api/telemetry/client-error", post(report_client_error));
}

/// An uncaught failure as the web UI describes it.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientError {
    /// Where the failure happened: the page itself or a named worker.
    source: String,
    /// `error` for a thrown exception, `rejection` for an unhandled promise rejection.
    kind: String,
    name: String,
    message: String,
    #[serde(default)]
    stack: Option<String>,
    /// Whether the failure left the web UI unusable.
    #[serde(default)]
    fatal: bool,
}

/// Captures a web UI failure as an error report. Always answers `204`, since the web UI has
/// nothing to do differently when reports are off.
async fn report_client_error(Json(error): Json<ClientError>) -> StatusCode {
    if super::reports_enabled() {
        sentry::capture_event(client_error_event(error));
    }
    StatusCode::NO_CONTENT
}

/// Builds the report for a web UI failure, parsing its stack so the error service can group
/// repeats of the same failure.
fn client_error_event(error: ClientError) -> Event<'static> {
    let stacktrace = error
        .stack
        .as_deref()
        .map(parse_stack)
        .filter(|frames| !frames.is_empty())
        .map(|frames| Stacktrace {
            frames,
            ..Default::default()
        });
    let mechanism = if error.kind == "rejection" {
        "onunhandledrejection"
    } else {
        "onerror"
    };
    Event {
        level: if error.fatal {
            Level::Fatal
        } else {
            Level::Error
        },
        platform: "javascript".into(),
        logger: Some("webui".into()),
        exception: vec![Exception {
            ty: truncate(&error.name, MAX_NAME_CHARS),
            value: Some(truncate(&error.message, MAX_MESSAGE_CHARS)),
            stacktrace,
            mechanism: Some(Mechanism {
                ty: mechanism.into(),
                handled: Some(false),
                ..Default::default()
            }),
            ..Default::default()
        }]
        .into(),
        tags: [
            ("origin".to_owned(), "webui".to_owned()),
            (
                "webui.source".to_owned(),
                truncate(&error.source, MAX_NAME_CHARS),
            ),
        ]
        .into(),
        ..Default::default()
    }
}

/// Keeps at most `limit` characters.
fn truncate(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Parses V8 (`at fn (url:line:col)`) and Firefox/WebKit (`fn@url:line:col`) stack lines into
/// frames ordered oldest first, as the error service expects. Lines in neither form, such as
/// the headline V8 repeats at the top, are skipped.
fn parse_stack(stack: &str) -> Vec<Frame> {
    let mut frames: Vec<Frame> = stack
        .lines()
        .filter_map(parse_frame)
        .take(MAX_FRAMES)
        .collect();
    frames.reverse();
    frames
}

/// Parses one stack line, or returns `None` when it is not a frame.
fn parse_frame(line: &str) -> Option<Frame> {
    let line = line.trim();
    let (function, location) = if let Some(rest) = line.strip_prefix("at ") {
        match rest
            .strip_suffix(')')
            .and_then(|rest| rest.split_once(" ("))
        {
            Some((function, location)) => (Some(function), location),
            None => (None, rest),
        }
    } else {
        let (function, location) = line.rsplit_once('@')?;
        ((!function.is_empty()).then_some(function), location)
    };
    let mut parts = location.rsplitn(3, ':');
    let column = parts.next()?.parse().ok()?;
    let line_number = parts.next()?.parse().ok()?;
    let path = parts.next()?;
    Some(Frame {
        function: function.map(str::to_owned),
        abs_path: Some(path.to_owned()),
        lineno: Some(line_number),
        colno: Some(column),
        in_app: Some(!path.contains("/node_modules/")),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Chromium stacks yield named and anonymous frames, oldest first, without the headline.
    #[test]
    fn parses_v8_stacks() {
        let frames = parse_stack(
            "TypeError: x is undefined\n    at render (http://localhost:7701/assets/app.js:10:5)\n    at http://localhost:7701/assets/main.js:2:1",
        );
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].function, None);
        assert_eq!(
            frames[0].abs_path.as_deref(),
            Some("http://localhost:7701/assets/main.js")
        );
        assert_eq!(frames[1].function.as_deref(), Some("render"));
        assert_eq!((frames[1].lineno, frames[1].colno), (Some(10), Some(5)));
    }

    /// Firefox and WebKit stacks use `function@location`.
    #[test]
    fn parses_firefox_stacks() {
        let frames = parse_stack(
            "render@http://localhost:7701/assets/app.js:10:5\n@http://localhost:7701/assets/main.js:2:1\n",
        );
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[1].function.as_deref(), Some("render"));
        assert_eq!(frames[0].function, None);
    }

    /// The report keeps the error's type, message, and origin, and marks fatal failures.
    #[test]
    fn builds_reports_from_client_errors() {
        let event = client_error_event(ClientError {
            source: "timeline worker".into(),
            kind: "rejection".into(),
            name: "RangeError".into(),
            message: "x".repeat(MAX_MESSAGE_CHARS + 10),
            stack: None,
            fatal: true,
        });
        assert_eq!(event.level, Level::Fatal);
        let exception = &event.exception.values[0];
        assert_eq!(exception.ty, "RangeError");
        assert_eq!(
            exception.value.as_ref().map(|value| value.chars().count()),
            Some(MAX_MESSAGE_CHARS)
        );
        assert_eq!(
            exception
                .mechanism
                .as_ref()
                .map(|mechanism| mechanism.ty.as_str()),
            Some("onunhandledrejection")
        );
        assert_eq!(
            event.tags.get("webui.source").map(String::as_str),
            Some("timeline worker")
        );
    }
}
