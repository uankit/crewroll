// swift-tools-version: 5.8
import PackageDescription

// Bound provenance for this host-only reader:
// - Swift-Sodium 0.11.0 signed tag object:
//   df17ff800f85491b2cdb5c9d0426dacb40761ad2
// - Resolved commit: cfd195c76882aa9b997560ca7cb95d72fbf5db00
// - GitHub tag archive SHA-256:
//   52b43b383a04e04a20eb40ee7b30d4e6a3ffc4ac7b09f9c9317bfdfd46461e81
// - Clibsodium.xcframework sorted inventory SHA-256:
//   6d54b959e2c6ec66875c1971bb05dbf475886722364193e030341ac02b0d9f43
// - macOS static slice SHA-256:
//   9e00d236b5fc294f48825edbc1ca8971dc418363dae8cc7787004d63454ed563
// - Swift-Sodium and bundled libsodium are ISC licensed; the headers report
//   libsodium 1.0.22 at upstream revision 8cda270b3b18ca103c57085752cece1ebbf5abee.

let package = Package(
    name: "CrewRollCryptoConformance",
    platforms: [.macOS(.v13)],
    products: [
        .library(
            name: "CrewRollCryptoConformance",
            targets: ["CrewRollCryptoConformance"]
        ),
    ],
    dependencies: [
        .package(
            url: "https://github.com/jedisct1/swift-sodium.git",
            exact: "0.11.0"
        ),
    ],
    targets: [
        .target(
            name: "CrewRollCryptoConformance",
            dependencies: [
                .product(name: "Clibsodium", package: "swift-sodium"),
            ]
        ),
        .testTarget(
            name: "CrewRollCryptoConformanceTests",
            dependencies: [
                "CrewRollCryptoConformance",
                .product(name: "Clibsodium", package: "swift-sodium"),
            ]
        ),
    ]
)
