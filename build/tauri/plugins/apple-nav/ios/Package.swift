// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-apple-nav",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-apple-nav",
      type: .static,
      targets: ["tauri-plugin-apple-nav"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-apple-nav",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
