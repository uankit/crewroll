import org.gradle.api.artifacts.dsl.LockMode
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

// Bound provenance for this host-only reader:
// - Gradle 8.11.1 bin ZIP SHA-256:
//   f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6
// - Lazysodium Java 5.2.0 JAR SHA-256:
//   29b495c9ba2fbb7ce0c198f3df48efcba753d1a112c2e7a7078d7491a770d2b6 (MPL-2.0)
// - JNA 5.17.0 JAR SHA-256:
//   b3a9408e7c51e08ef0e3bfcc08f443f6ec0f6191ba8cd7c18d53d2b22e5bdbc0
//   (Apache-2.0 or LGPL-2.1-or-later)
// - Lazysodium mac_arm/libsodium.dylib SHA-256:
//   f44a9e331997c4af1a0e325b23379750598d65bb56a974d7f34307f474a74f22 (ISC)
// - Lazysodium mac/libsodium.dylib SHA-256:
//   15db21a581a164feba6e5e12e70c53a3fad842268d217a7e5eb9462547cff38c (ISC)

plugins {
    kotlin("jvm") version "2.1.20"
}

providers.gradleProperty("crewrollConformanceBuildDirectory").orNull?.let { directory ->
    layout.buildDirectory.set(file(directory))
}

dependencies {
    implementation("com.goterl:lazysodium-java:5.2.0")
    implementation("net.java.dev.jna:jna:5.17.0")

    testImplementation("org.junit.jupiter:junit-jupiter-api:5.11.4")
    testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.11.4")
}

dependencyLocking {
    lockAllConfigurations()
    lockMode.set(LockMode.STRICT)
}

kotlin {
    jvmToolchain(21)
}

tasks.withType<KotlinCompile>().configureEach {
    compilerOptions {
        allWarningsAsErrors.set(true)
        jvmTarget.set(JvmTarget.JVM_21)
    }
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("failed", "passed", "skipped")
    }
}
