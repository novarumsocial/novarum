// Port of apps/frontend/src/lib/components/avatar-crop-dialog.svelte. Stub until ported: hands the
// image back uncropped.
use std::rc::Rc;

use crate::prelude::*;

pub struct CropOptions {
    pub title: SharedString,
    pub description: SharedString,
    pub action_label: SharedString,
    pub output_width: u32,
    pub output_height: u32,
}

impl Default for CropOptions {
    fn default() -> Self {
        Self {
            title: "Crop Avatar".into(),
            description: "Adjust the image to fit your profile.".into(),
            action_label: "Use Avatar".into(),
            output_width: 512,
            output_height: 512,
        }
    }
}

/// Opens the crop dialog for `image` (the picked file's bytes); `on_crop` gets the PNG result.
pub fn open_avatar_crop(
    image: Vec<u8>,
    options: CropOptions,
    on_crop: Rc<dyn Fn(Vec<u8>, &mut Window, &mut App)>,
    window: &mut Window,
    cx: &mut App,
) {
    let _ = options;
    on_crop(image, window, cx);
}
