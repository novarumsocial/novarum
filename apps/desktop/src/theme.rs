// Port of apps/frontend/src/routes/layout.css: the shadcn tokens, light and dark.
use gpui_kit::{
    component::{Theme, ThemeMode},
    *,
};

/// `oklch(l c h / a)` to gpui's Hsla, through linear sRGB.
pub fn oklch(l: f32, c: f32, h: f32, a: f32) -> Hsla {
    let (hr, c) = (h.to_radians(), c);
    let (oa, ob) = (c * hr.cos(), c * hr.sin());
    let l_ = l + 0.396_337_78 * oa + 0.215_803_76 * ob;
    let m_ = l - 0.105_561_346 * oa - 0.063_854_17 * ob;
    let s_ = l - 0.089_484_18 * oa - 1.291_485_5 * ob;
    let (l3, m3, s3) = (l_.powi(3), m_.powi(3), s_.powi(3));
    let lin = [
        4.076_741_7 * l3 - 3.307_711_6 * m3 + 0.230_969_94 * s3,
        -1.268_438 * l3 + 2.609_757_4 * m3 - 0.341_319_38 * s3,
        -0.004_196_086_3 * l3 - 0.703_418_6 * m3 + 1.707_614_7 * s3,
    ];
    let [r, g, b] = lin.map(|v| {
        let v = v.clamp(0.0, 1.0);
        if v <= 0.003_130_8 {
            12.92 * v
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        }
    });
    Rgba { r, g, b, a }.into()
}

/// The tokens of layout.css that gpui-component's theme has no slot for.
#[derive(Clone, Copy)]
pub struct Tokens {
    pub background: Hsla,
    pub foreground: Hsla,
    pub card: Hsla,
    pub primary: Hsla,
    pub primary_foreground: Hsla,
    pub secondary: Hsla,
    pub muted: Hsla,
    pub muted_foreground: Hsla,
    pub accent: Hsla,
    pub accent_foreground: Hsla,
    pub destructive: Hsla,
    pub destructive_foreground: Hsla,
    pub border: Hsla,
    pub input: Hsla,
    pub ring: Hsla,
    pub sidebar: Hsla,
    pub sidebar_foreground: Hsla,
    pub sidebar_primary: Hsla,
    pub sidebar_primary_foreground: Hsla,
    pub sidebar_accent: Hsla,
    pub sidebar_border: Hsla,
    pub link: Hsla,
    pub popover: Hsla,
    /// `--radius`: 0 unless "rounded borders" is on.
    pub radius: Pixels,
}

impl Global for Tokens {}

impl Tokens {
    pub fn light() -> Self {
        Self {
            background: oklch(0.985, 0.005, 326.0, 1.0),
            foreground: oklch(0.145, 0.008, 326.0, 1.0),
            card: oklch(0.97, 0.008, 322.12, 1.0),
            popover: oklch(0.97, 0.008, 322.12, 1.0),
            primary: oklch(0.45, 0.085, 224.283, 1.0),
            primary_foreground: oklch(0.984, 0.019, 200.873, 1.0),
            secondary: oklch(0.94, 0.006, 286.033, 1.0),
            muted: oklch(0.94, 0.01, 320.12, 1.0),
            muted_foreground: oklch(0.45, 0.02, 323.02, 1.0),
            accent: oklch(0.94, 0.01, 320.12, 1.0),
            accent_foreground: oklch(0.205, 0.0, 0.0, 1.0),
            destructive: oklch(0.577, 0.191, 22.216, 1.0),
            destructive_foreground: oklch(0.984, 0.019, 200.873, 1.0),
            border: oklch(0.0, 0.0, 0.0, 0.1),
            input: oklch(0.0, 0.0, 0.0, 0.15),
            ring: oklch(0.542, 0.034, 322.5, 1.0),
            sidebar: oklch(0.97, 0.008, 322.12, 1.0),
            sidebar_foreground: oklch(0.145, 0.008, 326.0, 1.0),
            sidebar_primary: oklch(0.45, 0.143, 215.221, 1.0),
            sidebar_primary_foreground: oklch(0.984, 0.019, 200.873, 1.0),
            sidebar_accent: oklch(0.94, 0.01, 320.12, 1.0),
            sidebar_border: oklch(0.0, 0.0, 0.0, 0.1),
            link: oklch(0.45, 0.143, 215.221, 1.0),
            radius: px(0.0),
        }
    }

    pub fn dark() -> Self {
        Self {
            background: oklch(0.145, 0.008, 326.0, 1.0),
            foreground: oklch(0.985, 0.0, 0.0, 1.0),
            card: oklch(0.212, 0.019, 322.12, 1.0),
            popover: oklch(0.212, 0.019, 322.12, 1.0),
            primary: oklch(0.45, 0.085, 224.283, 1.0),
            primary_foreground: oklch(0.984, 0.019, 200.873, 1.0),
            secondary: oklch(0.274, 0.006, 286.033, 1.0),
            muted: oklch(0.263, 0.024, 320.12, 1.0),
            muted_foreground: oklch(0.711, 0.019, 323.02, 1.0),
            accent: oklch(0.263, 0.024, 320.12, 1.0),
            accent_foreground: oklch(0.985, 0.0, 0.0, 1.0),
            destructive: oklch(0.704, 0.191, 22.216, 1.0),
            destructive_foreground: oklch(0.145, 0.008, 326.0, 1.0),
            border: oklch(1.0, 0.0, 0.0, 0.1),
            input: oklch(1.0, 0.0, 0.0, 0.15),
            ring: oklch(0.542, 0.034, 322.5, 1.0),
            sidebar: oklch(0.212, 0.019, 322.12, 1.0),
            sidebar_foreground: oklch(0.985, 0.0, 0.0, 1.0),
            sidebar_primary: oklch(0.715, 0.143, 215.221, 1.0),
            sidebar_primary_foreground: oklch(0.302, 0.056, 229.695, 1.0),
            sidebar_accent: oklch(0.263, 0.024, 320.12, 1.0),
            sidebar_border: oklch(1.0, 0.0, 0.0, 0.1),
            link: oklch(0.72, 0.1, 215.221, 1.0),
            radius: px(0.0),
        }
    }
}

pub fn tokens(cx: &App) -> Tokens {
    *cx.global::<Tokens>()
}

/// Applies dark mode and rounded borders, like +layout.svelte's effect on `<html>`.
pub fn apply(dark: bool, rounded: bool, cx: &mut App) {
    let mut t = if dark {
        Tokens::dark()
    } else {
        Tokens::light()
    };
    t.radius = if rounded { px(8.0) } else { px(0.0) };
    cx.set_global(t);

    Theme::change(
        if dark {
            ThemeMode::Dark
        } else {
            ThemeMode::Light
        },
        None,
        cx,
    );
    Theme::update(cx, |theme| {
        theme.font_family = "IBM Plex Sans".into();
        theme.font_size = px(16.0);
        theme.radius = t.radius;
        theme.radius_lg = t.radius;
        theme.shadow = false;
        let c = &mut theme.colors;
        c.background = t.background;
        c.foreground = t.foreground;
        c.border = t.border;
        c.input = t.input;
        c.ring = t.ring;
        c.primary = t.primary;
        c.primary_foreground = t.primary_foreground;
        c.primary_hover = t.primary.opacity(0.9);
        c.primary_active = t.primary.opacity(0.8);
        c.button_primary = t.primary;
        c.button_primary_foreground = t.primary_foreground;
        c.button_primary_hover = t.primary.opacity(0.9);
        c.button_primary_active = t.primary.opacity(0.8);
        c.secondary = t.secondary;
        c.secondary_hover = t.secondary.opacity(0.8);
        c.secondary_active = t.secondary.opacity(0.7);
        c.muted = t.muted;
        c.muted_foreground = t.muted_foreground;
        c.accent = t.accent;
        c.accent_foreground = t.accent_foreground;
        c.danger = t.destructive;
        c.danger_foreground = t.destructive_foreground;
        c.danger_hover = t.destructive.opacity(0.9);
        c.danger_active = t.destructive.opacity(0.8);
        c.popover = t.popover;
        c.popover_foreground = t.foreground;
        c.sidebar = t.sidebar;
        c.sidebar_foreground = t.sidebar_foreground;
        c.sidebar_primary = t.sidebar_primary;
        c.sidebar_primary_foreground = t.sidebar_primary_foreground;
        c.sidebar_accent = t.sidebar_accent;
        c.sidebar_accent_foreground = t.sidebar_foreground;
        c.sidebar_border = t.sidebar_border;
        c.link = t.link;
        c.title_bar = t.background;
        c.title_bar_border = t.border;
        c.list = t.background;
        c.list_hover = t.accent;
        c.list_active = t.accent;
        c.caret = t.foreground;
        c.selection = t.primary.opacity(0.35);
    });
    cx.refresh_windows();
}
