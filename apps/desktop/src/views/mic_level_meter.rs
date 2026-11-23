// Port of apps/frontend/src/lib/components/mic-level-meter.svelte.
use crate::prelude::*;

const N: usize = 20;

/// The analyser's time-domain RMS, boosted so speech fills most of the meter.
pub fn level_from_samples(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|sample| sample * sample).sum();
    ((sum / samples.len() as f32).sqrt() * 4.0).min(1.0)
}

pub fn lit_count(level: f32) -> usize {
    (level.clamp(0.0, 1.0) * N as f32).round() as usize
}

/// green for most of the bar, yellow when it gets loud, red when it's too loud
fn bar_color(index: usize) -> Hsla {
    let t = index as f32 / (N - 1) as f32;
    if t < 0.7 {
        hsla(142.0 / 360.0, 0.7, 0.45, 1.0)
    } else if t < 0.9 {
        hsla(45.0 / 360.0, 0.9, 0.55, 1.0)
    } else {
        hsla(0.0, 0.8, 0.55, 1.0)
    }
}

pub fn mic_level_meter(level: f32, cx: &App) -> Div {
    let t = theme::tokens(cx);
    let lit = lit_count(level);
    div()
        .flex()
        .h_5()
        .items_end()
        .gap(px(3.0))
        .children((0..N).map(|index| {
            div().h_5().w(px(3.0)).rounded(px(1.0)).bg(if index < lit {
                bar_color(index)
            } else {
                t.muted_foreground.opacity(0.25)
            })
        }))
}

#[cfg(test)]
mod tests {
    use super::{level_from_samples, lit_count};

    #[test]
    fn silence_lights_nothing_and_loud_input_lights_everything() {
        assert_eq!(level_from_samples(&[]), 0.0);
        assert_eq!(lit_count(level_from_samples(&[0.0; 64])), 0);
        assert_eq!(lit_count(level_from_samples(&[0.5, -0.5, 0.5, -0.5])), 20);
    }

    #[test]
    fn quiet_speech_lights_part_of_the_meter() {
        // rms 0.1 is boosted to 0.4: 8 of 20 bars
        assert_eq!(lit_count(level_from_samples(&[0.1, -0.1, 0.1, -0.1])), 8);
    }
}
