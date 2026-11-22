// Remote images (avatars, attachments, embeds, emoji) fetched with the session cookie and cached
// for the life of the app. GIF/WebP animate through gpui's `img`.
use std::{collections::HashMap, sync::Arc};

use crate::prelude::*;

use crate::api;

enum Entry {
    Loading,
    Ready(Arc<Image>),
    Failed,
}

#[derive(Default)]
struct ImageCache(HashMap<String, Entry>);
impl Global for ImageCache {}

fn format_for(bytes: &[u8]) -> ImageFormat {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => ImageFormat::Png,
        [0xFF, 0xD8, ..] => ImageFormat::Jpeg,
        [b'G', b'I', b'F', ..] => ImageFormat::Gif,
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => ImageFormat::Webp,
        [b'B', b'M', ..] => ImageFormat::Bmp,
        _ if bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml") => ImageFormat::Svg,
        _ => ImageFormat::Png,
    }
}

/// The image at `url` if it has loaded; starts loading it otherwise. `Err(())` once it failed,
/// so callers can show their fallback (like the web `onerror`).
pub fn remote(url: &str, cx: &mut App) -> Result<Option<Arc<Image>>, ()> {
    let cache = cx.default_global::<ImageCache>();
    match cache.0.get(url) {
        Some(Entry::Ready(image)) => return Ok(Some(image.clone())),
        Some(Entry::Failed) => return Err(()),
        Some(Entry::Loading) => return Ok(None),
        None => {}
    }
    cache.0.insert(url.to_string(), Entry::Loading);
    let url = url.to_string();
    cx.spawn(async move |cx| {
        let entry = match api::fetch_bytes(url.clone()).await {
            Ok(bytes) => Entry::Ready(Arc::new(Image::from_bytes(format_for(&bytes), bytes))),
            Err(_) => Entry::Failed,
        };
        cx.update(|cx| {
            cx.default_global::<ImageCache>().0.insert(url, entry);
            cx.refresh_windows();
        });
    })
    .detach();
    Ok(None)
}

/// An `<img>` that fills its box, or nothing while it loads.
pub fn remote_img(url: &str, cx: &mut App) -> Option<Img> {
    remote(url, cx).ok().flatten().map(|image| img(image).size_full())
}
