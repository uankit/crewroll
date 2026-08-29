package com.uankit53.crewroll.crypto

import com.goterl.lazysodium.SodiumJava
import com.sun.jna.NativeLibrary
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

class VerifiedSodiumProvider private constructor(
    val sodium: SodiumJava,
    val version: String,
    val extractedLibrary: Path,
    private val extractionDirectory: Path,
    private val versionLibrary: NativeLibrary,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)

    override fun close() {
        if (closed.compareAndSet(false, true)) {
            versionLibrary.close()
            Files.deleteIfExists(extractedLibrary)
            Files.deleteIfExists(extractionDirectory)
        }
    }

    companion object {
        private const val EXPECTED_VERSION = "1.0.20"
        private const val MAC_ARM_SHA256 =
            "f44a9e331997c4af1a0e325b23379750598d65bb56a974d7f34307f474a74f22"
        private const val MAC_X86_SHA256 =
            "15db21a581a164feba6e5e12e70c53a3fad842268d217a7e5eb9462547cff38c"

        fun open(): VerifiedSodiumProvider {
            val (resource, digest) = platformResource()
            return openVerified(
                resource = { SodiumJava::class.java.getResourceAsStream(resource) },
                expectedSha256 = digest,
                sodiumFactory = ::SodiumJava,
            )
        }

        internal fun openVerified(
            resource: () -> InputStream?,
            expectedSha256: String,
            sodiumFactory: (String) -> SodiumJava,
        ): VerifiedSodiumProvider {
            if (!expectedSha256.matches(Regex("^[0-9a-f]{64}$"))) {
                throw CryptoReadException(
                    CryptoFailure.STRUCTURE,
                    "bundled sodium SHA-256 is malformed",
                )
            }
            val directoryPermissions = PosixFilePermissions.asFileAttribute(
                setOf(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE,
                    PosixFilePermission.OWNER_EXECUTE,
                ),
            )
            val directory = Files.createTempDirectory(
                "crewroll-sodium-",
                directoryPermissions,
            )
            val libraryPath = directory.resolve("libsodium.dylib").toAbsolutePath()
            var versionLibrary: NativeLibrary? = null
            try {
                val input = resource() ?: throw CryptoReadException(
                    CryptoFailure.STRUCTURE,
                    "bound bundled sodium resource is missing",
                )
                input.use { source ->
                    Files.newOutputStream(
                        libraryPath,
                        StandardOpenOption.CREATE_NEW,
                        StandardOpenOption.WRITE,
                    ).use(source::copyTo)
                }
                Files.setPosixFilePermissions(
                    libraryPath,
                    setOf(
                        PosixFilePermission.OWNER_READ,
                        PosixFilePermission.OWNER_WRITE,
                    ),
                )
                val actualDigest = sha256(Files.readAllBytes(libraryPath)).toHex()
                if (actualDigest != expectedSha256) {
                    throw CryptoReadException(
                        CryptoFailure.CHECKSUM,
                        "bundled sodium SHA-256 disagrees",
                    )
                }

                val sodium = sodiumFactory(libraryPath.toString())
                if (sodium.sodium_init() < 0) {
                    throw CryptoReadException(
                        CryptoFailure.AUTHENTICATION,
                        "sodium_init failed",
                    )
                }
                versionLibrary = NativeLibrary.getInstance(libraryPath.toString())
                val version = versionLibrary
                    .getFunction("sodium_version_string")
                    .invokeString(emptyArray(), false)
                if (version != EXPECTED_VERSION) {
                    throw CryptoReadException(
                        CryptoFailure.SEMANTIC_CONTEXT,
                        "bundled sodium version disagrees",
                    )
                }
                return VerifiedSodiumProvider(
                    sodium = sodium,
                    version = version,
                    extractedLibrary = libraryPath,
                    extractionDirectory = directory,
                    versionLibrary = versionLibrary,
                )
            } catch (error: Throwable) {
                versionLibrary?.close()
                Files.deleteIfExists(libraryPath)
                Files.deleteIfExists(directory)
                throw error
            }
        }

        private fun platformResource(): Pair<String, String> {
            val operatingSystem = System.getProperty("os.name")
            if (operatingSystem != "Mac OS X") {
                throw CryptoReadException(
                    CryptoFailure.STRUCTURE,
                    "Kotlin conformance requires the designated macOS runner",
                )
            }
            return when (System.getProperty("os.arch").lowercase(Locale.ROOT)) {
                "aarch64", "arm64" -> "/mac_arm/libsodium.dylib" to MAC_ARM_SHA256
                "x86_64", "amd64" -> "/mac/libsodium.dylib" to MAC_X86_SHA256
                else -> throw CryptoReadException(
                    CryptoFailure.STRUCTURE,
                    "unsupported macOS architecture for bound sodium resource",
                )
            }
        }
    }
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
