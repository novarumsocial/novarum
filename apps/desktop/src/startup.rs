// NOVARUM_TRACE_STARTUP=1 prints how long each launch step took since the process started.
use std::{sync::LazyLock, time::Instant};

static START: LazyLock<Instant> = LazyLock::new(Instant::now);
static ENABLED: LazyLock<bool> =
    LazyLock::new(|| std::env::var_os("NOVARUM_TRACE_STARTUP").is_some());

pub fn mark(step: &str) {
    if *ENABLED {
        eprintln!(
            "[startup] {:>8.1}ms {step}",
            START.elapsed().as_secs_f64() * 1000.0
        );
    }
}
