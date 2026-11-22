// Port of apps/frontend/src/lib/components/animated-image.svelte. gpui's `img` already animates
// GIF and WebP frames; the web's freeze-on-blur (drawing the first frame to a canvas) has no gpui
// equivalent, so animated images always play.
use crate::prelude::*;

/// A remote image filling its box (`object-cover` or `object-contain`), or the empty box while
/// it loads. `None` once it failed, so the caller can show its fallback (the web `onerror`).
pub fn animated_image(src: &str, fit: ObjectFit, cx: &mut App) -> Option<AnyElement> {
    match crate::ui::image::remote(src, cx) {
        Ok(Some(image)) => Some(img(image).size_full().object_fit(fit).into_any_element()),
        Ok(None) => Some(div().size_full().into_any_element()),
        Err(()) => None,
    }
}
