// Port of apps/frontend/src/lib/voice-layout.ts (the layout math; `VoiceTile` comes with voice.rs).

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TileLayout {
    pub cols: usize,
    pub rows: usize,
    pub width: f32,
    pub height: f32,
}

const EMPTY: TileLayout = TileLayout {
    cols: 1,
    rows: 1,
    width: 0.0,
    height: 0.0,
};

/// Picks the arrangement that gives every tile the largest possible area inside `width` x `height`.
///
/// Tiles take their cell's own shape whenever that shape is reasonable, which is what makes the
/// grid fill the stage. `min_aspect`/`max_aspect` only kick in for extreme cells (never taller
/// than square, never wider than 2:1). When even the best arrangement would be unreadably small,
/// it returns a grid the caller can scroll.
pub fn fit_tiles_with(
    width: f32,
    height: f32,
    count: usize,
    gap: f32,
    min_aspect: f32,
    max_aspect: f32,
    min_width: f32,
) -> TileLayout {
    if count < 1 || width < 1.0 || height < 1.0 {
        return EMPTY;
    }

    let mut best = EMPTY;
    for cols in 1..=count {
        let rows = count.div_ceil(cols);
        // skip arrangements that would leave a whole trailing column empty
        if (cols - 1) * rows >= count {
            continue;
        }
        let cell_width = (width - gap * (cols - 1) as f32) / cols as f32;
        let cell_height = (height - gap * (rows - 1) as f32) / rows as f32;
        if cell_width < 1.0 || cell_height < 1.0 {
            continue;
        }
        let aspect = (cell_width / cell_height).clamp(min_aspect, max_aspect);
        let tile_width = cell_width.min(cell_height * aspect);
        if tile_width * (tile_width / aspect) <= best.width * best.height {
            continue;
        }
        best = TileLayout {
            cols,
            rows,
            width: tile_width,
            height: tile_width / aspect,
        };
    }

    if best.width < min_width {
        let cols = (((width + gap) / (min_width + gap)).floor() as usize).max(1);
        let tile_width = (width - gap * (cols - 1) as f32) / cols as f32;
        best = TileLayout {
            cols,
            rows: count.div_ceil(cols),
            width: tile_width,
            height: tile_width * 9.0 / 16.0,
        };
    }

    // floor so sub-pixel rounding can never push a tile onto the next row
    TileLayout {
        width: best.width.floor(),
        height: best.height.floor(),
        ..best
    }
}

pub fn fit_tiles(width: f32, height: f32, count: usize) -> TileLayout {
    fit_tiles_with(width, height, count, 8.0, 1.0, 2.0, 140.0)
}

/// Tailwind class names, as the web app has them; the views map them to colors.
const AVATAR_COLORS: [&str; 12] = [
    "bg-rose-600",
    "bg-sky-600",
    "bg-emerald-600",
    "bg-amber-600",
    "bg-purple-600",
    "bg-cyan-600",
    "bg-pink-600",
    "bg-lime-600",
    "bg-indigo-600",
    "bg-teal-600",
    "bg-orange-600",
    "bg-violet-600",
];

/// The same color the web app picks for `id`, so a person looks the same in both.
pub fn fallback_avatar_bg(id: &str) -> &'static str {
    // JS numbers: `<<` works on int32, the rest on doubles
    let mut hash = 0f64;
    for unit in id.encode_utf16() {
        let shifted = (hash as i64 as i32).wrapping_shl(5) as f64;
        hash = unit as f64 + (shifted - hash);
    }
    AVATAR_COLORS[(hash.abs() % AVATAR_COLORS.len() as f64) as usize]
}

pub fn initials_for(id: &str) -> String {
    id.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .take(2)
        .filter_map(|part| part.chars().next())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{fallback_avatar_bg, fit_tiles, initials_for};

    #[test]
    fn fills_a_wide_stage_with_two_tiles() {
        let layout = fit_tiles(1000.0, 400.0, 2);
        assert_eq!((layout.cols, layout.rows), (2, 1));
        assert_eq!(layout.width, 496.0);
        assert_eq!(layout.height, 400.0);
    }

    #[test]
    fn falls_back_to_a_scrolling_grid_when_tiles_get_tiny() {
        let layout = fit_tiles(600.0, 300.0, 40);
        assert_eq!(layout.cols, 4);
        assert_eq!(layout.rows, 10);
        assert!(fit_tiles(0.0, 300.0, 3).width == 0.0);
    }

    #[test]
    fn picks_stable_avatar_colors_and_initials() {
        assert_eq!(fallback_avatar_bg(""), "bg-rose-600");
        // same as the web app
        assert_eq!(fallback_avatar_bg("abc"), "bg-pink-600");
        assert_eq!(fallback_avatar_bg("novarum-user-123"), "bg-teal-600");
        assert_eq!(initials_for("ana-maria@x"), "AM");
        assert_eq!(initials_for("leo"), "L");
    }
}
