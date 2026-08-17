fn main() {
    let target = std::env::var("TARGET").expect("Cargo must provide TARGET to the desktop build script");
    println!("cargo:rustc-env=DSH_DESKTOP_TARGET_TRIPLE={target}");
    tauri_build::build()
}
