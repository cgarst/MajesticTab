// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-ios-fold",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-ios-fold",
      type: .static,
      targets: ["tauri-plugin-ios-fold"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-ios-fold",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
