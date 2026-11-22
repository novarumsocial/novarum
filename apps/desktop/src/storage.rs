// localStorage, on disk: one JSON object in the config dir, keyed like the web app's keys.
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex, sync::LazyLock};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

pub fn data_dir() -> PathBuf {
    let dir = std::env::var_os("NOVARUM_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("novarum"));
    let _ = fs::create_dir_all(&dir);
    dir
}

fn path() -> PathBuf {
    data_dir().join("storage.json")
}

static STORE: LazyLock<Mutex<HashMap<String, Value>>> = LazyLock::new(|| {
    Mutex::new(
        fs::read(path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default(),
    )
});

pub fn get<T: DeserializeOwned>(key: &str) -> Option<T> {
    let store = STORE.lock().unwrap();
    serde_json::from_value(store.get(key)?.clone()).ok()
}

pub fn set<T: Serialize>(key: &str, value: &T) {
    let mut store = STORE.lock().unwrap();
    store.insert(key.into(), serde_json::to_value(value).unwrap_or(Value::Null));
    let _ = fs::write(path(), serde_json::to_vec_pretty(&*store).unwrap_or_default());
}

pub fn remove(key: &str) {
    let mut store = STORE.lock().unwrap();
    store.remove(key);
    let _ = fs::write(path(), serde_json::to_vec_pretty(&*store).unwrap_or_default());
}
