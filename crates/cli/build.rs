// The platform this program is built for names its release file, so an update downloads the right one.
fn main() {
    println!(
        "cargo:rustc-env=RUNTRACE_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=runtrace.manifest");
    // Windows MSVC builds embed runtrace.manifest, which selects the segment heap for the whole process.
    // Other platforms and toolchains are unaffected.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("runtrace.manifest");
        println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-bins=/MANIFESTINPUT:{}",
            manifest.display()
        );
        // No UAC section: execution level and file/registry virtualization stay as before.
        println!("cargo:rustc-link-arg-bins=/MANIFESTUAC:NO");
    }
}
