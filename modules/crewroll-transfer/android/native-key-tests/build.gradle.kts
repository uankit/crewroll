import org.gradle.api.artifacts.dsl.LockMode
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins { kotlin("jvm") version "2.1.20" }

layout.buildDirectory.set(
  rootProject.file("../../../../.superpowers/sdd/native-identity-keys/kotlin-build")
)

sourceSets {
  main {
    kotlin.srcDir("../src/main/java/com/uankit53/crewroll/transfer/identitykeys")
    kotlin.srcDir("../src/main/java/com/uankit53/crewroll/transfer/media")
    kotlin.exclude("**/AndroidPhotoLibrary.kt")
    kotlin.exclude("**/AndroidNativeKeyInfrastructure.kt")
    kotlin.exclude("**/AndroidAccountScopedKeyStore.kt")
  }
  test {
    kotlin.srcDir("src/test/kotlin")
    kotlin.srcDir("../../../../packages/contracts/crypto/conformance/kotlin/src/main/kotlin")
  }
}

dependencies {
  implementation("com.goterl:lazysodium-java:5.2.0")
  implementation("net.java.dev.jna:jna:5.17.0")
  implementation("org.json:json:20250517")
  testImplementation("org.junit.jupiter:junit-jupiter-api:5.11.4")
  testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine:5.11.4")
  testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.11.4")
}

dependencyLocking { lockAllConfigurations(); lockMode.set(LockMode.STRICT) }
kotlin { jvmToolchain(21) }
tasks.withType<KotlinCompile>().configureEach {
  compilerOptions { allWarningsAsErrors.set(true); jvmTarget.set(JvmTarget.JVM_21) }
}
tasks.test { useJUnitPlatform(); testLogging { events("failed", "passed", "skipped") } }
