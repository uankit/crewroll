import Foundation
import XCTest

private enum FixtureTreeMismatch: Error {
    case paths(expected: [String], actual: [String])
    case length(path: String, expected: Int, actual: Int)
    case byte(path: String, offset: Int)
}

private enum FixtureTreeComparator {
    static func assertExact(
        expected: [String: Data],
        actual: [String: Data]
    ) throws {
        let expectedPaths = expected.keys.sorted()
        let actualPaths = actual.keys.sorted()
        guard expectedPaths == actualPaths else {
            throw FixtureTreeMismatch.paths(
                expected: expectedPaths,
                actual: actualPaths
            )
        }

        for path in expectedPaths {
            guard let expectedBytes = expected[path],
                  let actualBytes = actual[path] else {
                throw FixtureTreeMismatch.paths(
                    expected: expectedPaths,
                    actual: actualPaths
                )
            }
            guard expectedBytes.count == actualBytes.count else {
                throw FixtureTreeMismatch.length(
                    path: path,
                    expected: expectedBytes.count,
                    actual: actualBytes.count
                )
            }
            for offset in expectedBytes.indices
            where expectedBytes[offset] != actualBytes[offset] {
                throw FixtureTreeMismatch.byte(path: path, offset: offset)
            }
        }
    }
}

final class ReproductionTests: XCTestCase {
    private var packageRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private var committedVectorDirectory: URL {
        packageRoot.deletingLastPathComponent().appendingPathComponent("v1")
    }

    private func executableURL() throws -> URL {
        let candidate = Bundle(for: ReproductionTests.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("CrewRollVectorGenerator")
        if FileManager.default.isExecutableFile(atPath: candidate.path) {
            return candidate
        }
        throw NSError(
            domain: "CrewRollVectorGeneratorTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "generator executable missing"]
        )
    }

    @discardableResult
    private func run(_ arguments: [String]) throws -> Process {
        let process = Process()
        process.executableURL = try executableURL()
        process.arguments = arguments
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        return process
    }

    private func temporaryDirectory(named name: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("crewroll-vector-tests-\(UUID().uuidString)")
            .appendingPathComponent(name)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        addTeardownBlock {
            try? FileManager.default.removeItem(
                at: directory.deletingLastPathComponent()
            )
        }
        return directory
    }

    private func tree(at root: URL) throws -> [String: Data] {
        var result: [String: Data] = [:]
        func collect(_ directory: URL, prefix: String) throws {
            for name in try FileManager.default.contentsOfDirectory(
                atPath: directory.path
            ).sorted() {
                let file = directory.appendingPathComponent(name)
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(
                    atPath: file.path,
                    isDirectory: &isDirectory
                ) else { continue }
                let relative = prefix.isEmpty ? name : "\(prefix)/\(name)"
                if isDirectory.boolValue {
                    try collect(file, prefix: relative)
                } else {
                    result[relative] = try Data(contentsOf: file)
                }
            }
        }
        try collect(root, prefix: "")
        return result
    }

    func testTwoCleanGenerationsAreByteIdenticalAndReportBoundProvenance() throws {
        let first = try temporaryDirectory(named: "first")
        let second = try temporaryDirectory(named: "second")

        XCTAssertEqual(try run(["--output", first.path]).terminationStatus, 0)
        XCTAssertEqual(try run(["--output", second.path]).terminationStatus, 0)
        XCTAssertEqual(try tree(at: first), try tree(at: second))

        let index = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: Data(contentsOf: first.appendingPathComponent("index.json"))
            ) as? [String: Any]
        )
        let generator = try XCTUnwrap(index["generator"] as? [String: Any])
        XCTAssertEqual(generator["libsodiumVersion"] as? String, "1.0.22")
        XCTAssertEqual(
            generator["rng"] as? String,
            "crewroll-fixture-v1-do-not-ship"
        )
        XCTAssertEqual(generator["rngInstalledBeforeSodiumInit"] as? Bool, true)
    }

    func testFreshGenerationExactlyMatchesCommittedVectors() throws {
        let output = try temporaryDirectory(named: "committed-reproduction")

        XCTAssertEqual(try run(["--output", output.path]).terminationStatus, 0)
        try FixtureTreeComparator.assertExact(
            expected: tree(at: committedVectorDirectory),
            actual: tree(at: output)
        )
    }

    func testFixtureTreeComparisonRejectsMissingPath() {
        XCTAssertThrowsError(
            try FixtureTreeComparator.assertExact(
                expected: ["fixture.bin": Data([0])],
                actual: [:]
            )
        )
    }

    func testFixtureTreeComparisonRejectsExtraPath() {
        XCTAssertThrowsError(
            try FixtureTreeComparator.assertExact(
                expected: ["fixture.bin": Data([0])],
                actual: [
                    "fixture.bin": Data([0]),
                    "unexpected.bin": Data([1]),
                ]
            )
        )
    }

    func testFixtureTreeComparisonRejectsByteDrift() {
        XCTAssertThrowsError(
            try FixtureTreeComparator.assertExact(
                expected: ["fixture.bin": Data([0])],
                actual: ["fixture.bin": Data([1])]
            )
        )
    }

    func testRefusesCommittedAndNonemptyDestinations() throws {
        XCTAssertNotEqual(
            try run(["--output", committedVectorDirectory.path]).terminationStatus,
            0
        )

        let nonempty = try temporaryDirectory(named: "nonempty")
        try Data([0]).write(to: nonempty.appendingPathComponent("existing.bin"))
        XCTAssertNotEqual(try run(["--output", nonempty.path]).terminationStatus, 0)
    }

    func testEntropyTapeExhaustionAborts() throws {
        let process = try run(["--self-test-exhaustion"])
        XCTAssertNotEqual(process.terminationStatus, 0)
    }

    func testPrivateAndTestKeysExistOnlyInsideTheIndex() throws {
        let output = try temporaryDirectory(named: "keys")
        XCTAssertEqual(try run(["--output", output.path]).terminationStatus, 0)
        let generatedTree = try tree(at: output)
        let indexData = try XCTUnwrap(generatedTree["index.json"])
        let index = try XCTUnwrap(
            JSONSerialization.jsonObject(with: indexData) as? [String: Any]
        )
        let secrets = try XCTUnwrap(index["secrets"] as? [String: Any])
        XCTAssertEqual(secrets["fixtureOnly"] as? Bool, true)

        let rawSecrets = try secrets.compactMap { key, value -> Data? in
            guard key.hasSuffix("Base64"), let encoded = value as? String else {
                return nil
            }
            return try XCTUnwrap(Data(base64Encoded: encoded))
        }
        for (path, data) in generatedTree where path != "index.json" {
            for secret in rawSecrets {
                XCTAssertNil(
                    data.range(of: secret),
                    "\(path) leaked raw fixture key material"
                )
            }
        }
    }
}
