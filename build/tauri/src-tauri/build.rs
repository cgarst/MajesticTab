fn main() {
    println!("cargo:rerun-if-changed=../frontend-dist");
    println!("cargo:rerun-if-changed=../flatpak");
    tauri_build::build()
}
