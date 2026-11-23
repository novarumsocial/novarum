// Port of apps/frontend/src/lib/formatDate.ts. The browser's locale becomes LC_TIME/LANG.
use chrono::{DateTime, Datelike, Local, TimeZone};

use crate::state::settings::TimeFormat;

/// `navigator.language` uses 12-hour clocks in en-US and a few others; most of the world doesn't.
fn locale_uses_12_hours() -> bool {
    let locale = ["LC_ALL", "LC_TIME", "LANG"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()))
        .unwrap_or_default();
    [
        "en_US", "en_CA", "en_AU", "en_NZ", "en_PH", "en_IN", "hi_IN",
    ]
    .iter()
    .any(|prefix| locale.starts_with(prefix))
}

pub fn format_time<Tz: TimeZone>(date: &DateTime<Tz>, format: TimeFormat) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let twelve = match format {
        TimeFormat::Auto => locale_uses_12_hours(),
        TimeFormat::H12 => true,
        TimeFormat::H24 => false,
    };
    date.format(if twelve { "%I:%M %p" } else { "%H:%M" })
        .to_string()
}

/// "Today", "Yesterday" or "Nov 22, 2026".
pub fn format_date(date: &DateTime<Local>, now: &DateTime<Local>) -> String {
    let day = date.date_naive();
    let today = now.date_naive();
    if day == today {
        return "Today".into();
    }
    if today.pred_opt() == Some(day) {
        return "Yesterday".into();
    }
    format!("{} {}, {}", date.format("%b"), day.day(), day.year())
}

#[cfg(test)]
mod tests {
    use chrono::{Local, TimeZone};

    use super::{format_date, format_time};
    use crate::state::settings::TimeFormat;

    #[test]
    fn formats_days_relative_to_now() {
        let now = Local.with_ymd_and_hms(2026, 11, 22, 15, 5, 0).unwrap();
        assert_eq!(format_date(&now, &now), "Today");
        let yesterday = Local.with_ymd_and_hms(2026, 11, 21, 23, 0, 0).unwrap();
        assert_eq!(format_date(&yesterday, &now), "Yesterday");
        let older = Local.with_ymd_and_hms(2026, 3, 4, 9, 0, 0).unwrap();
        assert_eq!(format_date(&older, &now), "Mar 4, 2026");
    }

    #[test]
    fn formats_times_in_both_clocks() {
        let date = Local.with_ymd_and_hms(2026, 11, 22, 15, 5, 0).unwrap();
        assert_eq!(format_time(&date, TimeFormat::H12), "03:05 PM");
        assert_eq!(format_time(&date, TimeFormat::H24), "15:05");
    }
}
