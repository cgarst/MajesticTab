// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-google-auth",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-google-auth",
      type: .static,
      targets: ["tauri-plugin-google-auth"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-google-auth",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
