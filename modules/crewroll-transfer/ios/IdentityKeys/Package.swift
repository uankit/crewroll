// swift-tools-version: 5.9
import PackageDescription
import Foundation

let sodiumDependency: Package.Dependency
if let local = ProcessInfo.processInfo.environment["CREWROLL_SWIFT_SODIUM_PATH"] {
    sodiumDependency = .package(name: "swift-sodium", path: local)
} else {
    sodiumDependency = .package(name: "swift-sodium", path: "../Vendor")
}

let package = Package(
    name: "CrewRollNativeKeys",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "CrewRollNativeKeys", targets: ["CrewRollNativeKeys"])],
    dependencies: [sodiumDependency],
    targets: [
        .target(
            name: "CrewRollNativeKeys",
            dependencies: [.product(name: "Clibsodium", package: "swift-sodium")]
        ),
        .testTarget(
            name: "CrewRollNativeKeysTests",
            dependencies: ["CrewRollNativeKeys"]
        ),
    ]
)
