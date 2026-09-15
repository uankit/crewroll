// swift-tools-version: 5.9
import PackageDescription

// Test against the exact hash-locked binary shipped by the Expo native module.
let package = Package(
    name: "swift-sodium",
    products: [.library(name: "Clibsodium", targets: ["Clibsodium"])],
    targets: [.binaryTarget(name: "Clibsodium", path: "Clibsodium.xcframework")]
)
