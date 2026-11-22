// Our fonts, logo and sounds first, then gpui-kit's Lucide icons (`icons/<lucide-name>.svg`).
use std::borrow::Cow;

use gpui_kit::*;

#[derive(rust_embed::RustEmbed)]
#[folder = "assets"]
struct Own;

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some(file) = Own::get(path) {
            return Ok(Some(file.data));
        }
        gpui_kit::assets::AllAssets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut own: Vec<SharedString> =
            Own::iter().filter(|name| name.starts_with(path)).map(|name| name.to_string().into()).collect();
        own.extend(gpui_kit::assets::AllAssets.list(path)?);
        Ok(own)
    }
}

pub fn load_fonts(cx: &mut App) {
    let fonts = Own::iter()
        .filter(|name| name.starts_with("fonts/"))
        .filter_map(|name| Own::get(&name).map(|file| file.data))
        .collect();
    cx.text_system().add_fonts(fonts).expect("bundled fonts");
}
