// Port of apps/frontend/src/lib/noise-floor.ts.

fn to_db(rms: f32) -> f32 {
    20.0 * rms.max(1e-6).log10()
}

pub fn rms_db(samples: &[f32]) -> f32 {
    let sum: f32 = samples.iter().map(|sample| sample * sample).sum();
    to_db((sum / samples.len() as f32).sqrt())
}

/// speech always has gaps, so the quietest tenth of recent frames is the room's noise floor.
/// quiet rooms get a light touch that keeps the voice natural; loud ones get suppressed harder
pub fn auto_attenuation(levels_db: &[f32]) -> f32 {
    let mut sorted = levels_db.to_vec();
    sorted.sort_by(f32::total_cmp);
    let floor = sorted
        .get((sorted.len() as f32 * 0.1) as usize)
        .copied()
        .unwrap_or(-100.0);
    (floor + 90.0).clamp(12.0, 50.0).round()
}

#[cfg(test)]
mod tests {
    use super::{auto_attenuation, rms_db};

    fn room(floor_db: f32) -> Vec<f32> {
        let mut levels = vec![floor_db; 20];
        levels.extend(vec![-20.0; 60]); // talking
        levels
    }

    #[test]
    fn suppresses_noisy_rooms_harder_than_quiet_ones() {
        assert_eq!(auto_attenuation(&room(-65.0)), 25.0);
        assert_eq!(auto_attenuation(&room(-45.0)), 45.0);
    }

    #[test]
    fn ignores_speech_when_estimating_the_floor() {
        assert_eq!(
            auto_attenuation(&room(-65.0)),
            auto_attenuation(&[-65.0; 80])
        );
    }

    #[test]
    fn stays_within_a_safe_range() {
        assert_eq!(auto_attenuation(&room(-120.0)), 12.0);
        assert_eq!(auto_attenuation(&room(-10.0)), 50.0);
        assert_eq!(auto_attenuation(&[]), 12.0);
    }

    #[test]
    fn rms_db_measures_a_full_scale_square_wave_as_0_db() {
        assert!(rms_db(&[1.0, -1.0, 1.0, -1.0]).abs() < 1e-4);
        assert_eq!(rms_db(&[0.0; 4]), -120.0);
    }
}
