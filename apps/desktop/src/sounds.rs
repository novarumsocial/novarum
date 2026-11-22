// The web app's Howler sounds. rodio can't decode opus, so assets/sounds holds them as ogg/vorbis.
use std::{
    io::Cursor,
    sync::{LazyLock, Mutex, mpsc},
};

use gpui_kit::AssetSource;

type Sound = (Vec<u8>, f32);

// the output device lives on its own thread, opened once and shared by every sound
static PLAYER: LazyLock<Mutex<mpsc::Sender<Sound>>> = LazyLock::new(|| {
    let (sender, receiver) = mpsc::channel::<Sound>();
    let _ = std::thread::Builder::new().name("sounds".into()).spawn(move || {
        let Ok(mut stream) = rodio::OutputStreamBuilder::open_default_stream() else { return };
        stream.log_on_drop(false);
        for (bytes, volume) in receiver {
            let Ok(source) = rodio::Decoder::try_from(Cursor::new(bytes)) else { continue };
            let sink = rodio::Sink::connect_new(stream.mixer());
            sink.set_volume(volume);
            sink.append(source);
            sink.detach();
        }
    });
    Mutex::new(sender)
});

/// Plays `assets/sounds/<name>.ogg` (`notification`, `join`, `mute`...) at `volume` (0 to 1).
pub fn play(name: &str, volume: f32) {
    let Ok(Some(bytes)) = crate::assets::Assets.load(&format!("sounds/{name}.ogg")) else { return };
    let _ = PLAYER.lock().unwrap().send((bytes.into_owned(), volume.clamp(0.0, 1.0)));
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use gpui_kit::AssetSource;

    #[test]
    fn every_sound_decodes() {
        let names = crate::assets::Assets.list("sounds/").unwrap();
        assert!(names.len() >= 11);
        for name in names {
            let bytes = crate::assets::Assets.load(&name).unwrap().unwrap().into_owned();
            assert!(rodio::Decoder::try_from(Cursor::new(bytes)).is_ok(), "{name}");
        }
    }
}
