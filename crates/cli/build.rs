// The platform this program is built for names its release file, so an update downloads the right one.
fn main() {
    println!(
        "cargo:rustc-env=RUNTRACE_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    println!("cargo:rerun-if-changed=build.rs");
}
