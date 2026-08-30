pluginManagement { repositories { gradlePluginPortal(); mavenCentral() } }
dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories { mavenCentral() }
}
rootProject.name = "crewroll-native-key-tests"
gradle.startParameter.projectCacheDir =
  file("../../../../.superpowers/sdd/native-identity-keys/gradle-project-cache")
