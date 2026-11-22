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

/// Runs `future` on the IO runtime; the result can be awaited from a gpui task.
pub async fn io<T: Send + 'static>(future: impl Future<Output = T> + Send + 'static) -> T {
    RUNTIME.spawn(future).await.expect("io task panicked")
}
