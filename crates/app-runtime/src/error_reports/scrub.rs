// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Removes personal paths and showfile names from error reports before they are queued.

use std::path::Path;

use sentry::protocol::{Breadcrumb, Context, Event, Stacktrace, Value};

/// Extension of showfile directories; any name ending in it is replaced.
const SHOWFILE_EXTENSION: &str = ".nightfall-show";
/// Placeholder that replaces a showfile name.
const SHOWFILE_PLACEHOLDER: &str = "<showfile>";
/// Placeholder that replaces the operator's home directory.
const HOME_PLACEHOLDER: &str = "~";
/// Placeholder that replaces the Nightfall data directory.
const DATA_DIR_PLACEHOLDER: &str = "<data>";
/// Placeholder that replaces the host and port of a web address.
const HOST_PLACEHOLDER: &str = "<host>";
/// Show names shorter than this are not replaced on their own, since they would also match
/// ordinary words in messages.
const MIN_SHOW_NAME_LENGTH: usize = 4;

/// Text replacements for one report, resolved from the host's directories when it is built.
#[derive(Debug, Default)]
pub(super) struct Scrubber {
    /// Literal values to replace, longest first so a data directory inside the home directory
    /// keeps its own placeholder.
    replacements: Vec<(String, &'static str)>,
}

impl Scrubber {
    /// Collects the paths that identify this machine or its show: the active showfile directory
    /// and name, the data directory, and the home directory, each in its native and
    /// forward-slash spelling.
    pub(super) fn for_host() -> Self {
        Self::new(
            std::env::home_dir().as_deref(),
            nightfall::nightfall_data_dir().as_deref(),
            nightfall::active_show_data_dir().as_deref(),
        )
    }

    /// Builds a scrubber for explicit directories, so tests do not depend on the host.
    pub(super) fn new(home: Option<&Path>, data_dir: Option<&Path>, show: Option<&Path>) -> Self {
        let mut replacements = Vec::new();
        let mut push_path = |path: &Path, placeholder: &'static str| {
            let native = path
                .to_string_lossy()
                .trim_end_matches(['/', '\\'])
                .to_owned();
            if native.len() <= 1 {
                return;
            }
            let forward = native.replace('\\', "/");
            if forward != native {
                replacements.push((forward, placeholder));
            }
            replacements.push((native, placeholder));
        };
        if let Some(show) = show {
            push_path(show, SHOWFILE_PLACEHOLDER);
        }
        if let Some(data_dir) = data_dir {
            push_path(data_dir, DATA_DIR_PLACEHOLDER);
        }
        if let Some(home) = home {
            push_path(home, HOME_PLACEHOLDER);
        }
        if let Some(name) = show
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy())
            .map(|name| name.trim_end_matches(SHOWFILE_EXTENSION).to_owned())
            .filter(|name| name.chars().count() >= MIN_SHOW_NAME_LENGTH && name != "default")
        {
            replacements.push((name, SHOWFILE_PLACEHOLDER));
        }
        replacements.sort_by_key(|(value, _)| std::cmp::Reverse(value.len()));
        Self { replacements }
    }

    /// Returns `text` with known paths replaced and every showfile name masked.
    pub(super) fn text(&self, text: &str) -> String {
        let mut text = text.to_owned();
        for (value, placeholder) in &self.replacements {
            if text.contains(value.as_str()) {
                text = text.replace(value.as_str(), placeholder);
            }
        }
        mask_url_hosts(&mask_showfile_names(&text))
    }

    /// Scrubs an optional string in place.
    fn option(&self, value: &mut Option<String>) {
        if let Some(text) = value {
            *text = self.text(text);
        }
    }

    /// Scrubs every string inside a JSON value, leaving its shape intact.
    fn value(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.text(text),
            Value::Array(items) => items.iter_mut().for_each(|item| self.value(item)),
            Value::Object(fields) => fields.values_mut().for_each(|item| self.value(item)),
            _ => {}
        }
    }

    /// Scrubs everything in an event that can carry a path or a name, and drops the machine's
    /// host name and network address.
    pub(super) fn event(&self, event: &mut Event<'static>) {
        event.server_name = None;
        event.request = None;
        self.option(&mut event.message);
        if let Some(entry) = &mut event.logentry {
            entry.message = self.text(&entry.message);
            entry.params.iter_mut().for_each(|param| self.value(param));
        }
        self.option(&mut event.culprit);
        self.option(&mut event.transaction);
        self.stacktrace(&mut event.stacktrace);
        for exception in &mut event.exception.values {
            self.option(&mut exception.value);
            self.stacktrace(&mut exception.stacktrace);
        }
        for thread in &mut event.threads.values {
            self.option(&mut thread.name);
            self.stacktrace(&mut thread.stacktrace);
        }
        event.extra.values_mut().for_each(|value| self.value(value));
        for context in event.contexts.values_mut() {
            if let Context::Other(fields) = context {
                fields.values_mut().for_each(|value| self.value(value));
            }
        }
        for tag in event.tags.values_mut() {
            *tag = self.text(tag);
        }
        for breadcrumb in &mut event.breadcrumbs.values {
            self.breadcrumb(breadcrumb);
        }
    }

    /// Scrubs source paths in a stack trace and drops captured local variables.
    fn stacktrace(&self, stacktrace: &mut Option<Stacktrace>) {
        for frame in stacktrace
            .iter_mut()
            .flat_map(|trace| trace.frames.iter_mut())
        {
            self.option(&mut frame.abs_path);
            self.option(&mut frame.filename);
            frame.vars.clear();
        }
    }

    /// Scrubs a breadcrumb's message and fields.
    pub(super) fn breadcrumb(&self, breadcrumb: &mut Breadcrumb) {
        self.option(&mut breadcrumb.message);
        breadcrumb
            .data
            .values_mut()
            .for_each(|value| self.value(value));
    }
}

/// Replaces the name in front of every showfile extension, keeping the extension so readers can
/// still tell a showfile was involved.
fn mask_showfile_names(text: &str) -> String {
    if !text.contains(SHOWFILE_EXTENSION) {
        return text.to_owned();
    }
    let mut masked = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(SHOWFILE_EXTENSION) {
        let before = &rest[..index];
        let name_start = before
            .rfind(['/', '\\', '"', '\'', '`', '(', '[', '=', '\n'])
            .map_or(0, |separator| separator + 1);
        masked.push_str(&before[..name_start]);
        masked.push_str(SHOWFILE_PLACEHOLDER);
        masked.push_str(SHOWFILE_EXTENSION);
        rest = &rest[index + SHOWFILE_EXTENSION.len()..];
    }
    masked.push_str(rest);
    masked
}

/// Replaces the host and port of every web address, so addresses of the desk and of devices on
/// the venue network never leave the machine. Paths are kept, since they locate the failing
/// script.
fn mask_url_hosts(text: &str) -> String {
    if !text.contains("://") {
        return text.to_owned();
    }
    let mut masked = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("://") {
        let before = &rest[..index];
        let scheme_start = before
            .rfind(|character: char| !character.is_ascii_alphabetic())
            .map_or(0, |position| position + 1);
        let scheme = before[scheme_start..].to_ascii_lowercase();
        masked.push_str(before);
        masked.push_str("://");
        rest = &rest[index + 3..];
        if matches!(scheme.as_str(), "http" | "https" | "ws" | "wss") {
            let authority_end = rest
                .find(|character: char| {
                    matches!(character, '/' | '"' | '\'' | ')' | '>' | '?' | '#')
                        || character.is_whitespace()
                })
                .unwrap_or(rest.len());
            if authority_end > 0 {
                masked.push_str(HOST_PLACEHOLDER);
            }
            rest = &rest[authority_end..];
        }
    }
    masked.push_str(rest);
    masked
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use sentry::protocol::{Exception, Frame};

    use super::*;

    /// Returns a scrubber for a Unix-style home with the data directory and a show inside it.
    fn unix_scrubber() -> Scrubber {
        Scrubber::new(
            Some(Path::new("/home/alice")),
            Some(Path::new("/home/alice/.local/share/nightfall")),
            Some(Path::new(
                "/home/alice/Shows/Club Venue Friday.nightfall-show",
            )),
        )
    }

    /// Paths keep their structure while the home, data directory, and show are replaced, and the
    /// show's bare name is masked wherever it appears.
    #[test]
    fn replaces_home_data_and_show() {
        let scrubber = unix_scrubber();
        assert_eq!(
            scrubber.text("open /home/alice/Shows/Club Venue Friday.nightfall-show/showfile.json"),
            "open <showfile>/showfile.json"
        );
        assert_eq!(
            scrubber.text("read /home/alice/.local/share/nightfall/telemetry.json"),
            "read <data>/telemetry.json"
        );
        assert_eq!(
            scrubber.text("cannot load /home/alice/Documents/rig.png"),
            "cannot load ~/Documents/rig.png"
        );
        assert_eq!(
            scrubber.text("Saved 'Club Venue Friday'"),
            "Saved '<showfile>'"
        );
    }

    /// Showfiles other than the active one are still masked by their extension.
    #[test]
    fn masks_other_showfile_names() {
        let scrubber = Scrubber::default();
        assert_eq!(
            scrubber.text("copy \"/mnt/usb/Wedding Smith.nightfall-show\" failed"),
            "copy \"/mnt/usb/<showfile>.nightfall-show\" failed"
        );
        assert_eq!(
            scrubber.text("C:\\Shows\\Tour.nightfall-show\\a and b.nightfall-show"),
            "C:\\Shows\\<showfile>.nightfall-show\\<showfile>.nightfall-show"
        );
    }

    /// Web addresses keep their scheme and path but lose the host and port.
    #[test]
    fn masks_web_address_hosts() {
        let scrubber = Scrubber::default();
        assert_eq!(
            scrubber.text("at f (http://192.168.1.20:7701/assets/app.js:1:2)"),
            "at f (http://<host>/assets/app.js:1:2)"
        );
        assert_eq!(
            scrubber.text("socket wss://desk.local:7700 closed; see file:///tmp/x"),
            "socket wss://<host> closed; see file:///tmp/x"
        );
    }

    /// Windows paths are matched in both separator spellings.
    #[test]
    fn replaces_windows_home_in_both_spellings() {
        let scrubber = Scrubber::new(Some(&PathBuf::from("C:\\Users\\Alice")), None, None);
        assert_eq!(
            scrubber.text("C:\\Users\\Alice\\x and C:/Users/Alice/y"),
            "~\\x and ~/y"
        );
    }

    /// The default show's name and very short names are left alone, since masking them would
    /// garble unrelated words.
    #[test]
    fn leaves_common_words_alone() {
        let default_show = Scrubber::new(
            None,
            None,
            Some(Path::new("/data/drafts/default.nightfall-show")),
        );
        assert_eq!(
            default_show.text("use the default value"),
            "use the default value"
        );
        let short_show = Scrubber::new(None, None, Some(Path::new("/s/A.nightfall-show")));
        assert_eq!(short_show.text("A value"), "A value");
    }

    /// Events lose the host name and have paths removed from messages and stack frames.
    #[test]
    fn scrubs_events() {
        let scrubber = unix_scrubber();
        let mut event = Event {
            server_name: Some("alices-laptop".into()),
            message: Some("failed to read /home/alice/notes.txt".into()),
            exception: vec![Exception {
                value: Some("Club Venue Friday is corrupt".into()),
                stacktrace: Some(Stacktrace {
                    frames: vec![Frame {
                        abs_path: Some("/home/alice/src/main.rs".into()),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            }]
            .into(),
            ..Default::default()
        };
        scrubber.event(&mut event);
        assert_eq!(event.server_name, None);
        assert_eq!(event.message.as_deref(), Some("failed to read ~/notes.txt"));
        let exception = &event.exception.values[0];
        assert_eq!(exception.value.as_deref(), Some("<showfile> is corrupt"));
        assert_eq!(
            exception.stacktrace.as_ref().unwrap().frames[0]
                .abs_path
                .as_deref(),
            Some("~/src/main.rs")
        );
    }
}
