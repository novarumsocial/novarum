// Port of apps/frontend/src/lib/components/ui/color-picker/color-picker.svelte with
// `formats={['hex']}`: a saturation/brightness area, a hue bar and the hex value.
use std::{cell::Cell, rc::Rc};

use gpui_kit::component::{
    ActiveTheme,
    input::{Input, InputEvent, InputState},
};

use crate::prelude::*;
use crate::ui::drag::{DragPhase, drag_surface, fraction};

/// h in 0..360, s and v in 0..100, like the web picker's state.
pub fn hsv_to_rgb(h: f32, s: f32, v: f32) -> (u8, u8, u8) {
    let (s, v) = (s / 100.0, v / 100.0);
    let channel = |n: f32| {
        let k = (n + h / 60.0) % 6.0;
        v - v * s * k.min(4.0 - k).clamp(0.0, 1.0)
    };
    let to_byte = |value: f32| (value * 255.0).round() as u8;
    (
        to_byte(channel(5.0)),
        to_byte(channel(3.0)),
        to_byte(channel(1.0)),
    )
}

pub fn rgb_to_hsv(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let max = r.max(g).max(b);
    let delta = max - r.min(g).min(b);
    let h = if delta == 0.0 {
        0.0
    } else if max == r {
        60.0 * ((g - b) / delta).rem_euclid(6.0)
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    };
    let s = if max == 0.0 { 0.0 } else { delta / max * 100.0 };
    (h, s, max * 100.0)
}

/// `#rgb` or `#rrggbb`.
pub fn parse_hex(value: &str) -> Option<(u8, u8, u8)> {
    let hex = value.trim().strip_prefix('#')?;
    let byte = |text: &str| u8::from_str_radix(text, 16).ok();
    match hex.len() {
        3 => {
            let digits: Vec<String> = hex.chars().map(|c| format!("{c}{c}")).collect();
            Some((byte(&digits[0])?, byte(&digits[1])?, byte(&digits[2])?))
        }
        6 => Some((byte(&hex[0..2])?, byte(&hex[2..4])?, byte(&hex[4..6])?)),
        _ => None,
    }
}

pub fn hsv_to_hex(h: f32, s: f32, v: f32) -> String {
    let (r, g, b) = hsv_to_rgb(h, s, v);
    format!("#{r:02x}{g:02x}{b:02x}")
}

fn hsv_color(h: f32, s: f32, v: f32) -> Hsla {
    let (r, g, b) = hsv_to_rgb(h, s, v);
    rgb(u32::from_be_bytes([0, r, g, b])).into()
}

pub struct ColorPicker {
    h: f32,
    s: f32,
    v: f32,
    hex: Entity<InputState>,
    area_drag: Rc<Cell<bool>>,
    hue_drag: Rc<Cell<bool>>,
    _subscription: Subscription,
}

impl ColorPicker {
    pub fn new(value: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let hex = cx.new(|cx| InputState::new(window, cx).default_value(value.to_string()));
        let subscription = cx.subscribe(&hex, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change)
                && let Some((r, g, b)) = parse_hex(&input.read(cx).value())
            {
                (this.h, this.s, this.v) = rgb_to_hsv(r, g, b);
                cx.notify();
            }
        });
        let (h, s, v) = parse_hex(value)
            .map(|(r, g, b)| rgb_to_hsv(r, g, b))
            .unwrap_or((0.0, 0.0, 0.0));
        Self {
            h,
            s,
            v,
            hex,
            area_drag: Rc::default(),
            hue_drag: Rc::default(),
            _subscription: subscription,
        }
    }

    /// `#rrggbb`
    pub fn value(&self) -> String {
        hsv_to_hex(self.h, self.s, self.v)
    }

    pub fn set_value(&mut self, value: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((r, g, b)) = parse_hex(value) {
            (self.h, self.s, self.v) = rgb_to_hsv(r, g, b);
            self.sync_input(window, cx);
        }
    }

    fn sync_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.value();
        self.hex
            .update(cx, |hex, cx| hex.set_value(value, window, cx));
        cx.notify();
    }

    fn handle(
        this: &WeakEntity<Self>,
        edit: impl Fn(&mut Self, (f32, f32)) + 'static,
    ) -> impl Fn(DragPhase, Point<Pixels>, Bounds<Pixels>, &mut Window, &mut App) + 'static {
        let this = this.clone();
        move |phase, position, bounds, window, cx| {
            if phase == DragPhase::End {
                return;
            }
            let _ = this.update(cx, |picker, cx| {
                edit(picker, fraction(position, bounds));
                picker.sync_input(window, cx);
            });
        }
    }
}

impl Render for ColorPicker {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::tokens(cx);
        let this = cx.entity().downgrade();
        let (h, s, v) = (self.h, self.s, self.v);
        let thumb = || {
            div()
                .absolute()
                .size_3()
                .rounded_full()
                .border_2()
                .border_color(white())
        };
        let hue_stops = [0.0, 60.0, 120.0, 180.0, 240.0, 300.0, 360.0]
            .map(|hue| hsv_color(hue % 360.0, 100.0, 100.0));
        let area = div()
            .relative()
            .h_56()
            .w_full()
            .overflow_hidden()
            .rounded(t.radius)
            .bg(hsv_color(h, 100.0, 100.0))
            .child(div().absolute().inset_0().bg(linear_gradient(
                90.0,
                linear_color_stop(white(), 0.0),
                linear_color_stop(white().opacity(0.0), 1.0),
            )))
            .child(div().absolute().inset_0().bg(linear_gradient(
                0.0,
                linear_color_stop(black(), 0.0),
                linear_color_stop(black().opacity(0.0), 1.0),
            )))
            .child(
                thumb()
                    .left(relative(s / 100.0))
                    .top(relative(1.0 - v / 100.0))
                    .ml(px(-6.0))
                    .mt(px(-6.0))
                    .border_color(white())
                    .shadow_sm(),
            )
            .child(drag_surface(
                self.area_drag.clone(),
                CursorStyle::Crosshair,
                Self::handle(&this, |picker, (x, y)| {
                    picker.s = x * 100.0;
                    picker.v = (1.0 - y) * 100.0;
                }),
            ));
        let hue = div()
            .relative()
            .h_3()
            .w_full()
            .flex()
            .rounded_full()
            .children(hue_stops.windows(2).enumerate().map(|(index, pair)| {
                div()
                    .flex_1()
                    .h_full()
                    .when(index == 0, |segment| segment.rounded_l_full())
                    .when(index == 5, |segment| segment.rounded_r_full())
                    .bg(linear_gradient(
                        90.0,
                        linear_color_stop(pair[0], 0.0),
                        linear_color_stop(pair[1], 1.0),
                    ))
            }))
            .child(
                thumb()
                    .top_0()
                    .left(relative(h / 360.0))
                    .ml(px(-6.0))
                    .bg(white())
                    .border_0(),
            )
            .child(drag_surface(
                self.hue_drag.clone(),
                CursorStyle::PointingHand,
                Self::handle(&this, |picker, (x, _)| picker.h = x * 360.0),
            ));

        div()
            .flex()
            .flex_col()
            .gap_3()
            .p_3()
            .w(px(350.0))
            .bg(t.popover)
            .child(area)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .mt_1()
                            .size_8()
                            .flex_shrink_0()
                            .rounded(t.radius)
                            .border_1()
                            .border_color(t.border)
                            .bg(hsv_color(h, s, v)),
                    )
                    .child(div().flex().flex_1().flex_col().justify_center().child(hue)),
            )
            .child(
                div()
                    .flex()
                    .w_full()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .h_9()
                            .px_2()
                            .border_1()
                            .border_r_0()
                            .border_color(t.input)
                            .text_size(px(10.0))
                            .font_weight(FontWeight::MEDIUM)
                            .child("HEX"),
                    )
                    .child(
                        div()
                            .flex_1()
                            .font_family(cx.theme().mono_font_family.clone())
                            .text_size(px(10.0))
                            .child(Input::new(&self.hex)),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{hsv_to_hex, hsv_to_rgb, parse_hex, rgb_to_hsv};

    #[test]
    fn parses_short_and_long_hex() {
        assert_eq!(parse_hex("#005f78"), Some((0x00, 0x5f, 0x78)));
        assert_eq!(parse_hex("#fff"), Some((255, 255, 255)));
        assert_eq!(parse_hex("005f78"), None);
        assert_eq!(parse_hex("#00zz78"), None);
    }

    #[test]
    fn hsv_round_trips_through_rgb() {
        for hex in [
            "#005f78", "#00d492", "#6366f1", "#000000", "#ffffff", "#ff0000",
        ] {
            let (r, g, b) = parse_hex(hex).unwrap();
            let (h, s, v) = rgb_to_hsv(r, g, b);
            assert_eq!(hsv_to_hex(h, s, v), hex);
        }
        assert_eq!(hsv_to_rgb(120.0, 100.0, 100.0), (0, 255, 0));
    }
}
