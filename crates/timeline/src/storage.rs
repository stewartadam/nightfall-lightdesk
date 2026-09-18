// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::path::{Component, Path, PathBuf};
#[cfg(feature = "http")]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(feature = "http")]
use uuid::Uuid;

#[cfg(feature = "http")]
const TIMELINE_AUDIO_DIR: &str = "timeline-audio";

#[cfg(feature = "http")]
fn sanitize_audio_filename_stem(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len());
    let mut previous_was_dash = false;

    for character in value.chars() {
        let next = if character.is_ascii_alphanumeric() {
            Some(character.to_ascii_lowercase())
        } else if matches!(character, '-' | '_') {
            Some('-')
        } else {
            None
        };

        if let Some(next) = next {
            sanitized.push(next);
            previous_was_dash = false;
        } else if !previous_was_dash {
            sanitized.push('-');
            previous_was_dash = true;
        }
    }

    sanitized = sanitized.trim_matches('-').to_string();
    if sanitized.is_empty() {
        "track".to_string()
    } else {
        sanitized
    }
}

#[cfg(feature = "http")]
fn supported_audio_extension(filename: &str) -> Option<&'static str> {
    let extension = Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())?
        .to_ascii_lowercase();
    match extension.as_str() {
        "mp3" => Some("mp3"),
        "wav" => Some("wav"),
        "m4a" => Some("m4a"),
        "mp4" => Some("mp4"),
        _ => None,
    }
}

fn show_data_dir_path() -> Result<PathBuf, String> {
    nightfall::active_show_data_dir()
        .ok_or_else(|| "could not determine active show data directory".to_string())
}

#[cfg(feature = "http")]
pub(crate) fn timeline_audio_relative_path(
    timeline_uid: Uuid,
    original_filename: &str,
) -> Result<String, String> {
    let extension = supported_audio_extension(original_filename)
        .ok_or_else(|| format!("unsupported audio file type: {}", original_filename))?;
    let stem = Path::new(original_filename)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(sanitize_audio_filename_stem)
        .unwrap_or_else(|| "track".to_string());
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    Ok(format!(
        "{}/{}/{timestamp_ms}-{stem}.{extension}",
        TIMELINE_AUDIO_DIR,
        timeline_uid.simple()
    ))
}

fn is_safe_relative_showfile_path(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn resolve_timeline_audio_path_from(
    show_data_dir: &Path,
    audio_path: &str,
) -> Result<PathBuf, String> {
    if audio_path.trim().is_empty() {
        return Err("timeline audio path is empty".to_string());
    }

    let relative_path = Path::new(audio_path);
    if !is_safe_relative_showfile_path(relative_path) {
        return Err(format!("invalid timeline audio path: {}", audio_path));
    }

    Ok(show_data_dir.join(relative_path))
}

pub(crate) fn resolve_timeline_audio_path(audio_path: &str) -> Result<PathBuf, String> {
    resolve_timeline_audio_path_from(&show_data_dir_path()?, audio_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HTTP audio uploads retain the owning timeline in their stored relative path.
    #[cfg(feature = "http")]
    #[test]
    fn timeline_audio_relative_path_uses_timeline_uid_directory() {
        let timeline_uid = Uuid::from_u128(0x1234);
        let path =
            timeline_audio_relative_path(timeline_uid, "Intro Mix.Final!.mp3").expect("path");

        assert!(path.starts_with("timeline-audio/00000000000000000000000000001234/"));
        assert!(path.ends_with("-intro-mix-final.mp3"));
    }

    #[test]
    fn resolve_timeline_audio_path_from_uses_showfile_directory() {
        let resolved = resolve_timeline_audio_path_from(
            Path::new("/show-data"),
            "timeline-audio/abc123/42-track.wav",
        )
        .expect("resolved path");

        assert_eq!(
            resolved,
            Path::new("/show-data")
                .join("timeline-audio")
                .join("abc123")
                .join("42-track.wav")
        );
    }

    #[test]
    fn resolve_timeline_audio_path_from_resolves_root_level_resources() {
        let resolved = resolve_timeline_audio_path_from(Path::new("/show-data"), "demo-audio.mp3")
            .expect("resolved path");

        assert_eq!(resolved, Path::new("/show-data").join("demo-audio.mp3"));
    }

    #[test]
    fn resolve_timeline_audio_path_from_rejects_parent_segments() {
        let error = resolve_timeline_audio_path_from(
            Path::new("/show-data"),
            "timeline-audio/abc123/../escape.mp3",
        )
        .expect_err("invalid path should fail");

        assert!(error.contains("invalid timeline audio path"));
    }
}
