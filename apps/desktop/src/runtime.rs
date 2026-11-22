// reqwest and the websocket need tokio; gpui runs its own executor. IO runs on this runtime
// and gpui tasks just await the JoinHandle.
use std::{future::Future, sync::LazyLock};

use tokio::runtime::Runtime;

static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime")
});

pub fn handle() -> tokio::runtime::Handle {
    RUNTIME.handle().clone()
}

/// Starts `future` on the IO runtime right away; the result can be awaited from a gpui task.
pub fn io<T: Send + 'static>(
    future: impl Future<Output = T> + Send + 'static,
) -> impl Future<Output = T> {
    let task = RUNTIME.spawn(future);
    async move { task.await.expect("io task panicked") }
}
