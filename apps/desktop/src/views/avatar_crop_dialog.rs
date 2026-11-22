// Port of apps/frontend/src/lib/components/avatar-crop-dialog.svelte. svelte-easy-crop becomes a
// pan (drag) and zoom (slider or wheel) over a frame with the output's aspect ratio.
use std::{cell::Cell, io::Cursor, path::PathBuf, rc::Rc, sync::Arc};

use gpui_kit::component::{
    WindowExt,
    slider::{Slider, SliderEvent, SliderState},
};
use image::{DynamicImage, ImageDecoder, ImageReader, imageops::FilterType};

use crate::prelude::*;
use crate::{
    state::{chat::UploadFile, settings::SettingsStore},
    ui::drag::{DragPhase, drag_surface},
};

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

/// The image types every avatar and banner input accepts.
pub const IMAGE_TYPES: [&str; 4] = ["image/gif", "image/jpeg", "image/png", "image/webp"];

/// `<input type="file" accept="image/gif,image/jpeg,image/png,image/webp">`: resolves to the picked
/// file, `Ok(None)` when nothing was picked, or an error for files of another type.
pub fn pick_image(cx: &mut App) -> Task<Result<Option<UploadFile>, String>> {
    let paths = cx.prompt_for_paths(PathPromptOptions {
        files: true,
        directories: false,
        multiple: false,
        prompt: None,
    });
    cx.background_spawn(async move {
        let path: Option<PathBuf> = paths
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
            .and_then(|paths| paths.into_iter().next());
        let Some(path) = path else { return Ok(None) };
        let file = UploadFile::from_path(&path).map_err(|error| error.to_string())?;
        if !IMAGE_TYPES.contains(&file.content_type.as_str()) {
            return Err("Choose a GIF, JPEG, PNG, or WebP image.".into());
        }
        Ok(Some(file))
    })
}

/// The part of the source image (in its pixels) that ends up in the output.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CropRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// The size of the image on screen: it always covers the frame, then `zoom` enlarges it.
pub fn displayed_size(image: (f32, f32), frame: (f32, f32), zoom: f32) -> (f32, f32) {
    let scale = (frame.0 / image.0).max(frame.1 / image.1) * zoom;
    (image.0 * scale, image.1 * scale)
}

/// Keeps the image's center offset from the frame's center so that no empty space shows.
pub fn clamp_offset(
    offset: (f32, f32),
    image: (f32, f32),
    frame: (f32, f32),
    zoom: f32,
) -> (f32, f32) {
    let (width, height) = displayed_size(image, frame, zoom);
    let (max_x, max_y) = (
        ((width - frame.0) / 2.0).max(0.0),
        ((height - frame.1) / 2.0).max(0.0),
    );
    (offset.0.clamp(-max_x, max_x), offset.1.clamp(-max_y, max_y))
}

pub fn crop_rect(offset: (f32, f32), image: (f32, f32), frame: (f32, f32), zoom: f32) -> CropRect {
    let (width, height) = displayed_size(image, frame, zoom);
    let scale = width / image.0;
    let (x, y) = clamp_offset(offset, image, frame, zoom);
    CropRect {
        x: ((width - frame.0) / 2.0 - x) / scale,
        y: ((height - frame.1) / 2.0 - y) / scale,
        width: frame.0 / scale,
        height: frame.1 / scale,
    }
}

/// The canvas `drawImage` + `toBlob('image/png')` step.
pub fn render_crop(
    image: &DynamicImage,
    crop: CropRect,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    let x = (crop.x.round().max(0.0) as u32).min(image.width().saturating_sub(1));
    let y = (crop.y.round().max(0.0) as u32).min(image.height().saturating_sub(1));
    let crop_width = (crop.width.round() as u32).clamp(1, image.width() - x);
    let crop_height = (crop.height.round() as u32).clamp(1, image.height() - y);
    let cropped = image.crop_imm(x, y, crop_width, crop_height).resize_exact(
        width,
        height,
        FilterType::Lanczos3,
    );
    let mut bytes = Cursor::new(Vec::new());
    cropped
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(bytes.into_inner())
}

struct Loaded {
    source: Arc<DynamicImage>,
    preview: Arc<Image>,
    size: (f32, f32),
}

fn decode(bytes: Vec<u8>) -> Result<Loaded, String> {
    fn failed(_: impl std::fmt::Debug) -> String {
        "Could not read that image.".into()
    }
    let mut decoder = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(failed)?
        .into_decoder()
        .map_err(failed)?;
    let orientation = decoder.orientation().ok();
    let mut image = DynamicImage::from_decoder(decoder).map_err(failed)?;
    if let Some(orientation) = orientation {
        image.apply_orientation(orientation);
    }
    let mut preview = Cursor::new(Vec::new());
    image
        .write_to(&mut preview, image::ImageFormat::Png)
        .map_err(failed)?;
    Ok(Loaded {
        size: (image.width() as f32, image.height() as f32),
        preview: Arc::new(Image::from_bytes(ImageFormat::Png, preview.into_inner())),
        source: Arc::new(image),
    })
}

/// `sm:max-w-sm` minus the dialog's padding.
const DIALOG_WIDTH: f32 = 384.0;
const FRAME_WIDTH: f32 = DIALOG_WIDTH - 32.0;

struct CropView {
    options: CropOptions,
    loaded: Option<Loaded>,
    error: Option<String>,
    zoom: f32,
    offset: (f32, f32),
    drag_start: Option<(Point<Pixels>, (f32, f32))>,
    dragging: Rc<Cell<bool>>,
    slider: Entity<SliderState>,
    _subscription: Subscription,
}

impl CropView {
    fn new(bytes: Vec<u8>, options: CropOptions, cx: &mut Context<Self>) -> Self {
        let slider = cx.new(|_| {
            SliderState::new()
                .min(1.0)
                .max(3.0)
                .step(0.01)
                .default_value(1.0)
        });
        let subscription = cx.subscribe(&slider, |this, _, event: &SliderEvent, cx| {
            let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
            this.set_zoom(value.start(), cx);
        });
        cx.spawn(async move |this, cx| {
            let loaded = cx.background_spawn(async move { decode(bytes) }).await;
            let _ = this.update(cx, |this, cx| {
                match loaded {
                    Ok(loaded) => this.loaded = Some(loaded),
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
        Self {
            options,
            loaded: None,
            error: None,
            zoom: 1.0,
            offset: (0.0, 0.0),
            drag_start: None,
            dragging: Rc::new(Cell::new(false)),
            slider,
            _subscription: subscription,
        }
    }

    fn frame(&self) -> (f32, f32) {
        (
            FRAME_WIDTH,
            FRAME_WIDTH * self.options.output_height as f32 / self.options.output_width as f32,
        )
    }

    fn set_zoom(&mut self, zoom: f32, cx: &mut Context<Self>) {
        self.zoom = zoom.clamp(1.0, 3.0);
        if let Some(loaded) = &self.loaded {
            self.offset = clamp_offset(self.offset, loaded.size, self.frame(), self.zoom);
        }
        cx.notify();
    }

    fn drag(&mut self, phase: DragPhase, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(loaded) = &self.loaded else { return };
        match (phase, self.drag_start) {
            (DragPhase::Start, _) => self.drag_start = Some((position, self.offset)),
            (DragPhase::Move, Some((start, offset))) => {
                let moved = (
                    offset.0 + f32::from(position.x - start.x),
                    offset.1 + f32::from(position.y - start.y),
                );
                self.offset = clamp_offset(moved, loaded.size, self.frame(), self.zoom);
            }
            _ => self.drag_start = None,
        }
        cx.notify();
    }

    fn crop(&self) -> Option<Result<Vec<u8>, String>> {
        let loaded = self.loaded.as_ref()?;
        let rect = crop_rect(self.offset, loaded.size, self.frame(), self.zoom);
        Some(render_crop(
            &loaded.source,
            rect,
            self.options.output_width,
            self.options.output_height,
        ))
    }
}

impl Render for CropView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let frame = self.frame();
        // round icons crop avatars as circles; banners always stay rectangles
        let round = SettingsStore::get(cx).circle_icons
            && self.options.output_width == self.options.output_height;
        let this = cx.entity().downgrade();

        let mut area = div()
            .id("crop-area")
            .relative()
            .mx_auto()
            .w(px(frame.0))
            .h(px(frame.1))
            .overflow_hidden()
            .bg(t.muted)
            .on_scroll(cx.listener(|this, event: &ScrollEvent, window, cx| {
                let delta = f32::from(event.delta.pixel_delta(window.line_height()).y);
                let zoom = (this.zoom + delta / 200.0).clamp(1.0, 3.0);
                this.slider
                    .update(cx, |slider, cx| slider.set_value(zoom, window, cx));
                this.set_zoom(zoom, cx);
            }));
        if let Some(loaded) = &self.loaded {
            let (width, height) = displayed_size(loaded.size, frame, self.zoom);
            let (x, y) = clamp_offset(self.offset, loaded.size, frame, self.zoom);
            area = area
                .child(
                    img(loaded.preview.clone())
                        .absolute()
                        .left(px((frame.0 - width) / 2.0 + x))
                        .top(px((frame.1 - height) / 2.0 + y))
                        .w(px(width))
                        .h(px(height)),
                )
                .when(round, |area| {
                    // a thick ring around the circle dims everything outside it
                    let ring = frame.0;
                    area.child(
                        div()
                            .absolute()
                            .left(px(-ring))
                            .top(px(-ring))
                            .size(px(frame.0 + ring * 2.0))
                            .rounded_full()
                            .border(px(ring))
                            .border_color(black().opacity(0.5)),
                    )
                })
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .border_1()
                        .border_color(white().opacity(0.5))
                        .when(round, |outline| outline.rounded_full()),
                )
                .child(drag_surface(
                    self.dragging.clone(),
                    CursorStyle::OpenHand,
                    move |phase, position, _, _, cx| {
                        if let Some(this) = this.upgrade() {
                            this.update(cx, |this, cx| this.drag(phase, position, cx));
                        }
                    },
                ));
        } else if let Some(error) = &self.error {
            area = area
                .flex()
                .items_center()
                .justify_center()
                .child(ui::error_text(error.clone(), cx));
        }

        div().flex().flex_col().gap_4().child(area).child(
            div()
                .flex()
                .flex_col()
                .gap_1()
                .text_xs()
                .child(div().text_color(t.muted_foreground).child("Zoom"))
                .child(Slider::new(&self.slider)),
        )
    }
}

pub type OnCrop = Rc<dyn Fn(Vec<u8>, &mut Window, &mut App)>;

/// Opens the crop dialog for `image` (the picked file's bytes); `on_crop` gets the PNG result.
pub fn open_avatar_crop(
    image: Vec<u8>,
    options: CropOptions,
    on_crop: OnCrop,
    window: &mut Window,
    cx: &mut App,
) {
    let view = cx.new(|cx| CropView::new(image, options, cx));
    window.open_dialog(cx, move |dialog, _, cx| {
        let t = theme::tokens(cx);
        let state = view.read(cx);
        let ready = state.loaded.is_some();
        let (title, description, action) = (
            state.options.title.clone(),
            state.options.description.clone(),
            state.options.action_label.clone(),
        );
        let (apply_view, on_crop) = (view.clone(), on_crop.clone());
        dialog
            .w(px(DIALOG_WIDTH))
            .title(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(title),
                    )
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::NORMAL)
                            .text_color(t.muted_foreground)
                            .child(description),
                    ),
            )
            .child(view.clone())
            .footer(
                div()
                    .flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        Button::new("crop-cancel")
                            .outline()
                            .label("Cancel")
                            .on_click(|_, window, cx| window.close_dialog(cx)),
                    )
                    .child(
                        Button::new("crop-apply")
                            .primary()
                            .label(action)
                            .disabled(!ready)
                            .on_click(move |_, window, cx| match apply_view.read(cx).crop() {
                                Some(Ok(bytes)) => {
                                    window.close_dialog(cx);
                                    on_crop(bytes, window, cx);
                                }
                                Some(Err(error)) => apply_view.update(cx, |view, cx| {
                                    view.error = Some(error);
                                    cx.notify();
                                }),
                                None => {}
                            }),
                    ),
            )
    });
}

#[cfg(test)]
mod tests {
    use image::{DynamicImage, GenericImageView, Rgba, RgbaImage};

    use super::{CropRect, clamp_offset, crop_rect, displayed_size, render_crop};

    #[test]
    fn the_image_covers_the_frame_at_zoom_one() {
        assert_eq!(
            displayed_size((1000.0, 500.0), (100.0, 100.0), 1.0),
            (200.0, 100.0)
        );
        assert_eq!(
            displayed_size((1000.0, 500.0), (100.0, 100.0), 2.0),
            (400.0, 200.0)
        );
    }

    #[test]
    fn panning_stops_at_the_image_edges() {
        assert_eq!(
            clamp_offset((500.0, 30.0), (1000.0, 500.0), (100.0, 100.0), 1.0),
            (50.0, 0.0)
        );
        assert_eq!(
            clamp_offset((-500.0, 0.0), (1000.0, 500.0), (100.0, 100.0), 1.0),
            (-50.0, 0.0)
        );
    }

    #[test]
    fn a_centered_crop_takes_the_middle_square() {
        let crop = crop_rect((0.0, 0.0), (1000.0, 500.0), (100.0, 100.0), 1.0);
        assert_eq!(
            crop,
            CropRect {
                x: 250.0,
                y: 0.0,
                width: 500.0,
                height: 500.0
            }
        );
        // dragging the image right shows more of its left side
        let left = crop_rect((50.0, 0.0), (1000.0, 500.0), (100.0, 100.0), 1.0);
        assert_eq!(left.x, 0.0);
        let zoomed = crop_rect((0.0, 0.0), (1000.0, 500.0), (100.0, 100.0), 2.0);
        assert_eq!(
            zoomed,
            CropRect {
                x: 375.0,
                y: 125.0,
                width: 250.0,
                height: 250.0
            }
        );
    }

    #[test]
    fn renders_the_crop_at_the_output_size() {
        let mut source = RgbaImage::from_pixel(40, 20, Rgba([0, 0, 255, 255]));
        for y in 0..20 {
            for x in 0..20 {
                source.put_pixel(x, y, Rgba([255, 0, 0, 255]));
            }
        }
        let crop = CropRect {
            x: 0.0,
            y: 0.0,
            width: 20.0,
            height: 20.0,
        };
        let png = render_crop(&DynamicImage::ImageRgba8(source), crop, 8, 8).unwrap();
        let output = image::load_from_memory(&png).unwrap();
        assert_eq!(output.dimensions(), (8, 8));
        assert_eq!(output.get_pixel(4, 4), Rgba([255, 0, 0, 255]));
    }
}
