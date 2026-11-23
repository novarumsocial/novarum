// The Windows .exe carries the app icon itself; the installer's shortcuts and the taskbar use it.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut resource = winresource::WindowsResource::new();
        resource.set_icon("packaging/icons/icon.ico");
        resource
            .compile()
            .expect("failed to embed the Windows icon");
    }
}
