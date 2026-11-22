// Port of apps/frontend/src/lib/system-message.ts.
use crate::models::{SystemMessage, SystemTarget};

fn name_of<'a>(display_name: Option<&'a str>, username: &'a str) -> &'a str {
    display_name.filter(|name| !name.is_empty()).unwrap_or(username)
}

fn list(targets: &[SystemTarget]) -> String {
    let names: Vec<&str> =
        targets.iter().map(|target| name_of(target.display_name.as_deref(), &target.username)).collect();
    match names.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        Some((last, _)) => last.to_string(),
        None => String::new(),
    }
}

pub fn format_duration(seconds: u64) -> String {
    let (h, m, s) = (seconds / 3600, (seconds % 3600) / 60, seconds % 60);
    if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

/// "Ana added Leo", "Missed call from Ana"... for a message the homeserver wrote.
pub fn system_text(system: &SystemMessage, display_name: Option<&str>, username: &str) -> String {
    let who = name_of(display_name, username);
    match system {
        SystemMessage::GroupCreated => format!("{who} created the group."),
        SystemMessage::MemberAdded { targets } => format!("{who} added {} to the group.", list(targets)),
        SystemMessage::MemberRemoved { targets } => format!("{who} removed {} from the group.", list(targets)),
        SystemMessage::MemberLeft => format!("{who} left the group."),
        SystemMessage::BotAdded { targets } => format!("{who} added the bot {}.", list(targets)),
        SystemMessage::BotRemoved { targets } => format!("{who} removed the bot {}.", list(targets)),
        SystemMessage::OwnerChanged { targets } => format!("{who} made {} the group owner.", list(targets)),
        SystemMessage::GroupRenamed { name } if name.is_empty() => format!("{who} removed the group name."),
        SystemMessage::GroupRenamed { name } => format!("{who} renamed the group to {name}."),
        SystemMessage::GroupIcon => format!("{who} changed the group icon."),
        SystemMessage::Call { missed: true, .. } => format!("Missed call from {who}."),
        SystemMessage::Call { duration_seconds: None, .. } => format!("{who} started a call."),
        SystemMessage::Call { duration_seconds: Some(seconds), .. } => {
            format!("{who} started a call that lasted {}.", format_duration(*seconds))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{format_duration, system_text};
    use crate::models::{SystemMessage, SystemTarget};

    fn target(name: &str) -> SystemTarget {
        SystemTarget { username: name.to_lowercase(), homeserver: "x".into(), display_name: Some(name.into()) }
    }

    #[test]
    fn describes_group_changes() {
        let added = SystemMessage::MemberAdded { targets: vec![target("Leo"), target("Mia"), target("Kai")] };
        assert_eq!(system_text(&added, Some("Ana"), "ana"), "Ana added Leo, Mia and Kai to the group.");
        let removed = SystemMessage::MemberRemoved { targets: vec![target("Leo")] };
        assert_eq!(system_text(&removed, None, "ana"), "ana removed Leo from the group.");
        let renamed = SystemMessage::GroupRenamed { name: String::new() };
        assert_eq!(system_text(&renamed, Some(""), "ana"), "ana removed the group name.");
    }

    #[test]
    fn describes_calls() {
        let missed = SystemMessage::Call { duration_seconds: None, missed: true };
        assert_eq!(system_text(&missed, Some("Ana"), "ana"), "Missed call from Ana.");
        let started = SystemMessage::Call { duration_seconds: None, missed: false };
        assert_eq!(system_text(&started, Some("Ana"), "ana"), "Ana started a call.");
        let lasted = SystemMessage::Call { duration_seconds: Some(125), missed: false };
        assert_eq!(system_text(&lasted, Some("Ana"), "ana"), "Ana started a call that lasted 2m 5s.");
        assert_eq!(format_duration(3725), "1h 2m");
        assert_eq!(format_duration(9), "9s");
    }
}
