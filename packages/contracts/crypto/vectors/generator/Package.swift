// swift-tools-version: 5.8
import PackageDescription

let package = Package(
    name: "CrewRollVectorGenerator",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(
            url: "https://github.com/jedisct1/swift-sodium.git",
            exact: "0.11.0"
        ),
    ],
    targets: [
        .target(
            name: "CRFixtureRng",
            dependencies: [
                .product(name: "Clibsodium", package: "swift-sodium"),
            ],
            publicHeadersPath: "include"
        ),
        .executableTarget(
            name: "CrewRollVectorGenerator",
            dependencies: [
                "CRFixtureRng",
                .product(name: "Clibsodium", package: "swift-sodium"),
            ]
        ),
        .testTarget(
            name: "CrewRollVectorGeneratorTests",
            dependencies: ["CrewRollVectorGenerator"]
        ),
    ]
)
