// Pointer dragging over an area, like the web's mousedown + window mousemove/mouseup pattern
// (the color picker's sliders, the avatar cropper). Place it as an absolute `inset_0` child.
use std::{cell::Cell, rc::Rc};

use crate::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragPhase {
    Start,
    Move,
    End,
}

/// The position within `bounds` as fractions, clamped to 0..=1.
pub fn fraction(position: Point<Pixels>, bounds: Bounds<Pixels>) -> (f32, f32) {
    let x = f32::from(position.x - bounds.origin.x) / f32::from(bounds.size.width).max(1.0);
    let y = f32::from(position.y - bounds.origin.y) / f32::from(bounds.size.height).max(1.0);
    (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0))
}

/// `dragging` must outlive the frame (keep it in the view), since the drag spans many frames.
pub fn drag_surface(
    dragging: Rc<Cell<bool>>,
    cursor: CursorStyle,
    on_drag: impl Fn(DragPhase, Point<Pixels>, Bounds<Pixels>, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let on_drag = Rc::new(on_drag);
    canvas(
        |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
        move |bounds, hitbox, window, _| {
            window.set_cursor_style(cursor, &hitbox);
            let (down, moved, up) = (on_drag.clone(), on_drag.clone(), on_drag);
            let (down_flag, move_flag, up_flag) = (dragging.clone(), dragging.clone(), dragging);
            window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble
                    && event.button == MouseButton::Left
                    && hitbox.is_hovered(window)
                {
                    down_flag.set(true);
                    down(DragPhase::Start, event.position, bounds, window, cx);
                }
            });
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                if phase == DispatchPhase::Capture && move_flag.get() {
                    if event.pressed_button == Some(MouseButton::Left) {
                        moved(DragPhase::Move, event.position, bounds, window, cx);
                    } else {
                        move_flag.set(false);
                    }
                }
            });
            window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                if phase == DispatchPhase::Capture && up_flag.replace(false) {
                    up(DragPhase::End, event.position, bounds, window, cx);
                }
            });
        },
    )
    .absolute()
    .inset_0()
}

#[cfg(test)]
mod tests {
    use gpui_kit::{Bounds, point, px, size};

    use super::fraction;

    #[test]
    fn fractions_are_clamped_to_the_area() {
        let bounds = Bounds::new(point(px(10.0), px(20.0)), size(px(100.0), px(50.0)));
        assert_eq!(fraction(point(px(60.0), px(45.0)), bounds), (0.5, 0.5));
        assert_eq!(fraction(point(px(0.0), px(500.0)), bounds), (0.0, 1.0));
    }
}
