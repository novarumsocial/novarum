// Port of apps/frontend/src/lib/zoom-pan.svelte.ts: zoom (wheel, pinch) and pan (drag while
// zoomed) for one element's content. The content is scaled from its top-left corner and kept
// covering the element, so it can't be dragged out of view. Only the math: the view feeds it
// the element's size and the pointer positions.

fn clamp(value: f32, min: f32, max: f32) -> f32 {
    value.max(min).min(max)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ZoomPan {
    pub scale: f32,
    pub x: f32,
    pub y: f32,
    /// the element's size, as last laid out
    pub width: f32,
    pub height: f32,
    /// true once a gesture moved the content, so the click that ends it can be ignored
    pub moved: bool,
    max: f32,
}

impl ZoomPan {
    pub fn new(max: f32) -> Self {
        Self {
            scale: 1.0,
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
            moved: false,
            max,
        }
    }

    pub fn zoomed(&self) -> bool {
        self.scale > 1.001
    }

    pub fn reset(&mut self) {
        self.scale = 1.0;
        self.x = 0.0;
        self.y = 0.0;
    }

    /// Keeps the content point under (`px`, `py`) in place while scaling.
    pub fn zoom_at(&mut self, px: f32, py: f32, scale: f32) {
        let next = clamp(scale, 1.0, self.max);
        let content_x = (px - self.x) / self.scale;
        let content_y = (py - self.y) / self.scale;
        self.scale = next;
        self.pan(
            px - content_x * next - self.x,
            py - content_y * next - self.y,
        );
    }

    /// Zooms around the middle, for keyboard shortcuts.
    pub fn zoom_by(&mut self, factor: f32) {
        self.zoom_at(self.width / 2.0, self.height / 2.0, self.scale * factor);
    }

    pub fn pan(&mut self, dx: f32, dy: f32) {
        self.x = clamp(self.x + dx, self.width * (1.0 - self.scale), 0.0);
        self.y = clamp(self.y + dy, self.height * (1.0 - self.scale), 0.0);
    }

    /// A wheel tick: trackpad pinches arrive as ctrl+wheel with small deltas, so they get a
    /// stronger factor. `delta_y` is positive when scrolling down (zooming out), like the DOM's.
    pub fn wheel(&mut self, px: f32, py: f32, delta_y: f32, pinch: bool) {
        let factor = (-delta_y * if pinch { 0.01 } else { 0.0015 }).exp();
        self.zoom_at(px, py, self.scale * factor);
    }
}

#[cfg(test)]
mod tests {
    use super::ZoomPan;

    fn sized() -> ZoomPan {
        let mut zoom = ZoomPan::new(5.0);
        zoom.width = 200.0;
        zoom.height = 100.0;
        zoom
    }

    #[test]
    fn zooming_keeps_the_point_under_the_cursor() {
        let mut zoom = sized();
        zoom.zoom_at(50.0, 50.0, 2.0);
        assert_eq!((zoom.scale, zoom.x, zoom.y), (2.0, -50.0, -50.0));
        // the content point at (50, 50) is still drawn at (50, 50)
        assert_eq!((50.0 - zoom.x) / zoom.scale, 50.0);
        assert!(zoom.zoomed());
    }

    #[test]
    fn scale_is_clamped_and_content_keeps_covering_the_element() {
        let mut zoom = sized();
        zoom.zoom_at(0.0, 0.0, 50.0);
        assert_eq!(zoom.scale, 5.0);
        zoom.pan(-10_000.0, 10_000.0);
        assert_eq!((zoom.x, zoom.y), (-800.0, 0.0));
        zoom.zoom_at(10.0, 10.0, 0.1);
        assert_eq!((zoom.scale, zoom.x, zoom.y), (1.0, 0.0, 0.0));
        assert!(!zoom.zoomed());
    }

    #[test]
    fn zooms_by_a_factor_around_the_middle_and_by_wheel() {
        let mut zoom = sized();
        zoom.zoom_by(2.0);
        assert_eq!((zoom.x, zoom.y), (-100.0, -50.0));
        zoom.reset();
        zoom.wheel(100.0, 50.0, -100.0, false);
        assert!(zoom.scale > 1.0);
        zoom.wheel(100.0, 50.0, 10_000.0, true);
        assert_eq!(zoom.scale, 1.0);
    }
}
