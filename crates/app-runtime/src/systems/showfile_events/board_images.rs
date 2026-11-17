// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Images shown on board buttons: upload normalization, storage in the show folder, and the
//! copy and cleanup rules that keep them travelling with the show.
//!
//! Images are stored once per content under `board-images/<sha256>.<ext>`, so the same picture
//! used on many buttons is one file and its name never changes while it exists.

use std::collections::HashSet;
use std::io::Cursor;
use std::path::Path;

use axum::{
    Json,
    extract::{DefaultBodyLimit, Multipart},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use nightfall::prelude::*;
use nightfall_showfile::ShowfileImportPolicy;
use sha2::{Digest, Sha256};

use super::{assets::copy_imported_showfile_asset_file, paths::show_data_dir_path};

/// Largest file accepted before normalizing, so a phone photo still uploads.
const BOARD_IMAGE_UPLOAD_LIMIT_BYTES: usize = 5 * 1024 * 1024;

/// Largest SVG stored as is; vector icons are far smaller, and big ones slow every client.
const BOARD_IMAGE_SVG_LIMIT_BYTES: usize = 512 * 1024;

/// Longest side, in pixels, of a stored raster image: a large button at twice pixel density.
pub(crate) const BOARD_IMAGE_MAX_SIDE: u32 = 256;

/// Largest side, in pixels, of an upload the server agrees to decode.
const BOARD_IMAGE_MAX_DECODED_SIDE: u32 = 8192;

/// Most memory one upload may take while decoding.
const BOARD_IMAGE_MAX_DECODED_BYTES: u64 = 256 * 1024 * 1024;

/// Body returned after storing an uploaded board image.
#[derive(serde::Serialize)]
struct BoardImageUploadResponse {
    /// ID to store on the board element.
    image: String,
}

/// Limits board image upload bodies to the accepted file size plus multipart framing.
pub(super) fn board_image_upload_limit() -> DefaultBodyLimit {
    DefaultBodyLimit::max(BOARD_IMAGE_UPLOAD_LIMIT_BYTES + 64 * 1024)
}

/// Stores one uploaded image in the active show's board images and returns its ID.
///
/// The image is normalized off the async runtime because decoding and resizing a large photo
/// takes tens of milliseconds.
pub(super) async fn upload_board_image(mut multipart: Multipart) -> Response {
    let field = match multipart.next_field().await {
        Ok(Some(field)) => field,
        Ok(None) => return (StatusCode::BAD_REQUEST, "missing image upload").into_response(),
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                format!("failed to read upload: {error}"),
            )
                .into_response();
        }
    };
    let bytes = match field.bytes().await {
        Ok(bytes) if bytes.is_empty() => {
            return (StatusCode::BAD_REQUEST, "the image file is empty").into_response();
        }
        Ok(bytes) if bytes.len() > BOARD_IMAGE_UPLOAD_LIMIT_BYTES => {
            return (StatusCode::PAYLOAD_TOO_LARGE, "images can be at most 5 MB").into_response();
        }
        Ok(bytes) => bytes,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                format!("failed to read upload: {error}"),
            )
                .into_response();
        }
    };

    let stored = tokio::task::spawn_blocking(move || {
        let show_data_dir = show_data_dir_path()?;
        let (contents, extension) = normalize_board_image(&bytes)?;
        store_board_image(&show_data_dir, &contents, extension)
    })
    .await;
    match stored {
        Ok(Ok(image)) => Json(BoardImageUploadResponse { image }).into_response(),
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, error).into_response(),
        Err(error) => {
            tracing::warn!(%error, "Board image upload task failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to store the image",
            )
                .into_response()
        }
    }
}

/// Turns uploaded bytes into what is stored: SVG text as is, any raster image as a PNG whose
/// longest side is at most [`BOARD_IMAGE_MAX_SIDE`]. Returns the bytes and their extension.
///
/// Animated images keep only their first frame.
pub(crate) fn normalize_board_image(bytes: &[u8]) -> Result<(Vec<u8>, &'static str), String> {
    if looks_like_svg(bytes) {
        if bytes.len() > BOARD_IMAGE_SVG_LIMIT_BYTES {
            return Err("SVG images can be at most 512 KB".to_string());
        }
        return Ok((bytes.to_vec(), "svg"));
    }

    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("could not read the image: {error}"))?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif)
    ) {
        return Err("use a PNG, JPEG, WebP, GIF or SVG image".to_string());
    }
    // A tiny, highly compressed file can still claim huge dimensions; refuse those before
    // allocating their pixels.
    let mut limits = Limits::default();
    limits.max_image_width = Some(BOARD_IMAGE_MAX_DECODED_SIDE);
    limits.max_image_height = Some(BOARD_IMAGE_MAX_DECODED_SIDE);
    limits.max_alloc = Some(BOARD_IMAGE_MAX_DECODED_BYTES);
    reader.limits(limits);
    let read_error = |error: image::ImageError| format!("could not read the image: {error}");
    let mut decoder = reader.into_decoder().map_err(read_error)?;
    // Phone photos store their rotation separately from the pixels.
    let orientation = decoder.orientation().map_err(read_error)?;
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(read_error)?;
    decoded.apply_orientation(orientation);
    if decoded.width() > BOARD_IMAGE_MAX_SIDE || decoded.height() > BOARD_IMAGE_MAX_SIDE {
        decoded = decoded.thumbnail(BOARD_IMAGE_MAX_SIDE, BOARD_IMAGE_MAX_SIDE);
    }
    let mut png = Vec::new();
    decoded
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .map_err(|error| format!("could not convert the image: {error}"))?;
    Ok((png, "png"))
}

/// Returns whether the bytes are SVG markup: UTF-8 text whose first element is `<svg`, after
/// any XML declaration, doctype or comments.
fn looks_like_svg(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut rest = text.trim_start_matches('\u{feff}').trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("<svg") {
            return after
                .starts_with(|next: char| next.is_whitespace() || next == '>' || next == '/');
        }
        let skipped = if rest.starts_with("<?") {
            rest.find("?>").map(|end| end + 2)
        } else if rest.starts_with("<!--") {
            rest.find("-->").map(|end| end + 3)
        } else if rest.starts_with("<!") {
            // A doctype may carry an internal subset in brackets, as editors such as
            // Illustrator write it; it ends at the `>` after the closing bracket.
            match (rest.find('['), rest.find('>')) {
                (Some(open), Some(close)) if open < close => rest[open..]
                    .find("]")
                    .and_then(|end| rest[open + end..].find('>').map(|gt| open + end + gt + 1)),
                (_, close) => close.map(|end| end + 1),
            }
        } else {
            None
        };
        match skipped {
            Some(end) => rest = rest[end..].trim_start(),
            None => return false,
        }
    }
}

/// Writes image bytes under their content hash and returns the image ID, reusing the file when
/// the same image was stored before.
pub(crate) fn store_board_image(
    show_data_dir: &Path,
    contents: &[u8],
    extension: &str,
) -> Result<String, String> {
    let digest: String = Sha256::digest(contents)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let id = format!("{digest}.{extension}");
    let directory = show_data_dir.join(BOARD_IMAGE_DIR);
    let path = directory.join(&id);
    if path.is_file() {
        return Ok(id);
    }
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create the board image folder: {error}"))?;
    // Write a uniquely named file beside the target and rename it, so a reader never sees a
    // half-written image and two uploads of the same picture do not trip over each other.
    let stored = tempfile::NamedTempFile::new_in(&directory).and_then(|mut partial| {
        std::io::Write::write_all(&mut partial, contents)?;
        partial.persist(&path).map_err(|error| error.error)?;
        Ok(())
    });
    match stored {
        Ok(()) => Ok(id),
        Err(_) if path.is_file() => Ok(id),
        Err(error) => Err(format!("could not store the image: {error}")),
    }
}

/// Returns the image IDs that the boards' buttons show.
fn referenced_board_images(boards: &[Board]) -> HashSet<&str> {
    boards
        .iter()
        .flat_map(|board| &board.elements)
        .filter_map(|element| element.image.as_deref())
        .filter(|image| is_board_image_id(image))
        .collect()
}

/// Removes board images that no button in `boards` shows from a show folder.
///
/// Only files named like board images are touched, so anything else placed in the folder stays.
pub(super) fn remove_orphaned_board_images(
    boards: &[Board],
    show_data_dir: &Path,
) -> Result<(), String> {
    let directory = show_data_dir.join(BOARD_IMAGE_DIR);
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("could not read {}: {error}", directory.display())),
    };
    let referenced = referenced_board_images(boards);
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if is_board_image_id(name) && !referenced.contains(name) {
            std::fs::remove_file(entry.path())
                .map_err(|error| format!("could not remove board image {name}: {error}"))?;
        }
    }
    Ok(())
}

/// Copies the images shown by imported boards from the imported show into the current one.
///
/// Board images are named by content, so an image already present is left as it is.
pub(super) fn copy_imported_board_images(
    current: &[Board],
    incoming: &[Board],
    policy: ShowfileImportPolicy,
    source_show_data_dir: &Path,
    current_show_data_dir: &Path,
) -> Result<(), String> {
    let imported_uids = super::assets::imported_identified_uids(current, incoming, policy);
    let imported: Vec<Board> = incoming
        .iter()
        .filter(|board| imported_uids.contains(&board.identifiers.uid))
        .cloned()
        .collect();
    for image in referenced_board_images(&imported) {
        let destination = current_show_data_dir.join(BOARD_IMAGE_DIR).join(image);
        if destination.is_file() {
            continue;
        }
        let source = source_show_data_dir.join(BOARD_IMAGE_DIR).join(image);
        if !source.is_file() {
            tracing::warn!(
                image,
                "An imported board shows an image the show does not have"
            );
            continue;
        }
        copy_imported_showfile_asset_file(&source, &destination, "board image")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use image::RgbaImage;

    use super::*;

    /// Encodes a solid image of the given size in `format`.
    fn encoded(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([200, 40, 40, 255]),
        ));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), format)
            .expect("test image should encode");
        bytes
    }

    /// Builds a board holding one button for each image ID.
    fn board_showing(images: &[&str]) -> Board {
        Board {
            elements: images
                .iter()
                .enumerate()
                .map(|(index, image)| BoardElement {
                    cell: BoardCell {
                        x: index as u32,
                        ..Default::default()
                    },
                    image: Some((*image).to_string()),
                    kind: BoardElementKind::Target {
                        target: ObjectIdentity {
                            object_type: ObjectType::Group,
                            uid: uuid::Uuid::new_v4(),
                        },
                    },
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    /// Large photos shrink to the stored size, keep their aspect ratio and become PNG.
    #[test]
    fn raster_images_are_downscaled_to_png() {
        let (png, extension) =
            normalize_board_image(&encoded(1024, 512, ImageFormat::Jpeg)).expect("normalizes");
        assert_eq!(extension, "png");
        let stored = image::load_from_memory_with_format(&png, ImageFormat::Png)
            .expect("stored image is a PNG");
        assert_eq!((stored.width(), stored.height()), (256, 128));
    }

    /// Small images keep their size so icons stay crisp.
    #[test]
    fn small_images_keep_their_size() {
        let (png, _) =
            normalize_board_image(&encoded(48, 32, ImageFormat::Png)).expect("normalizes");
        let stored = image::load_from_memory(&png).expect("stored image decodes");
        assert_eq!((stored.width(), stored.height()), (48, 32));
    }

    /// SVG markup is stored as is, while other text and oversized SVGs are refused.
    #[test]
    fn svg_is_kept_and_other_text_refused() {
        let svg = br#"<?xml version="1.0"?><!-- icon --><svg xmlns="http://www.w3.org/2000/svg"/>"#;
        assert_eq!(normalize_board_image(svg), Ok((svg.to_vec(), "svg")));
        let illustrator = br#"<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x" [
	<!ENTITY ns_svg "http://www.w3.org/2000/svg">
]><svg xmlns="&ns_svg;"/>"#;
        assert!(normalize_board_image(illustrator).is_ok());
        assert!(normalize_board_image(b"<svgx>text</svgx>").is_err());
        assert!(normalize_board_image(b"<html><svg/></html>").is_err());
        assert!(normalize_board_image(b"not an image").is_err());
        let huge = format!("<svg>{}</svg>", " ".repeat(BOARD_IMAGE_SVG_LIMIT_BYTES));
        assert!(normalize_board_image(huge.as_bytes()).is_err());
    }

    /// Formats outside the supported list are refused even when the decoder knows them.
    #[test]
    fn unsupported_formats_are_refused() {
        let tiff_header = b"II*\0\x08\0\0\0";
        let error = normalize_board_image(tiff_header).expect_err("refused");
        assert!(error.contains("PNG, JPEG"), "{error}");
    }

    /// Storing the same bytes twice yields one file and the same ID.
    #[test]
    fn stored_images_are_named_by_content() {
        let show = tempfile::tempdir().expect("temp dir");
        let first = store_board_image(show.path(), b"same", "png").expect("stores");
        let second = store_board_image(show.path(), b"same", "png").expect("stores");
        assert_eq!(first, second);
        assert!(is_board_image_id(&first));
        assert_eq!(
            std::fs::read_dir(show.path().join(BOARD_IMAGE_DIR))
                .expect("folder exists")
                .count(),
            1
        );
    }

    /// Cleanup removes only board images no button shows and leaves other files alone.
    #[test]
    fn orphaned_images_are_removed() {
        let show = tempfile::tempdir().expect("temp dir");
        let kept = store_board_image(show.path(), b"kept", "png").expect("stores");
        let orphan = store_board_image(show.path(), b"orphan", "svg").expect("stores");
        let folder = show.path().join(BOARD_IMAGE_DIR);
        std::fs::write(folder.join("notes.txt"), "keep").expect("writes");

        remove_orphaned_board_images(&[board_showing(&[&kept])], show.path()).expect("cleans");

        assert!(folder.join(&kept).is_file());
        assert!(!folder.join(&orphan).exists());
        assert!(folder.join("notes.txt").is_file());
    }

    /// Importing a board brings the images its buttons show into the current show.
    #[test]
    fn imported_boards_bring_their_images() {
        let source = tempfile::tempdir().expect("temp dir");
        let target = tempfile::tempdir().expect("temp dir");
        let image = store_board_image(source.path(), b"imported", "png").expect("stores");
        let mut incoming = board_showing(&[&image]);
        incoming.identifiers.id = 1;

        copy_imported_board_images(
            &[],
            &[incoming],
            ShowfileImportPolicy::Merge,
            source.path(),
            target.path(),
        )
        .expect("copies");

        assert!(target.path().join(BOARD_IMAGE_DIR).join(&image).is_file());
    }
}
