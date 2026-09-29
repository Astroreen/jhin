import java.io.File

pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    // Gradle creates .gradle/ cache dirs inside every included build root, but
    // the Flutter SDK can live in a read-only location (e.g. the Nix store).
    // In that case materialize a writable, fully-dereferenced copy under
    // GRADLE_USER_HOME (keyed by SDK path) and include that instead. Regular
    // writable SDK installs are included as-is.
    val flutterGradleSrc = file("$flutterSdkPath/packages/flutter_tools/gradle")
    val flutterGradleDir =
        if (java.nio.file.Files.isDirectory(flutterGradleSrc.toPath()) &&
            java.nio.file.Files.isWritable(flutterGradleSrc.toPath())
        ) {
            flutterGradleSrc
        } else {
            val hash =
                java.security.MessageDigest.getInstance("SHA-256")
                    .digest(flutterGradleSrc.absolutePath.toByteArray(Charsets.UTF_8))
                    .joinToString("") { "%02x".format(it) }
                    .take(16)
            val gradleUserHome =
                System.getenv("GRADLE_USER_HOME")
                    ?: File(System.getProperty("user.home"), ".gradle").path
            val dest = File(gradleUserHome, "flutter-tools-gradle/$hash")
            if (!dest.exists()) {
                dest.parentFile.mkdirs()
                val tmp = File(dest.parentFile, "${dest.name}.tmp-${ProcessHandle.current().pid()}")
                tmp.deleteRecursively()
                flutterGradleSrc.copyRecursively(tmp, overwrite = true)
                // The Nix-packaged SDK ships a settings.gradle wrapper that
                // relocates the build dir relative to the original SDK layout
                // (engine.version file at <sdk>/bin/internal/engine.version). Our copy already
                // lives in a writable cache dir, so plain settings.gradle.kts
                // is all we need.
                File(tmp, "settings.gradle").delete()
                if (!tmp.renameTo(dest)) {
                    tmp.deleteRecursively()
                    require(dest.exists()) { "failed to materialize writable copy of $flutterGradleSrc" }
                }
            }
            File(dest, "settings.gradle").delete()
            dest
        }

    includeBuild(flutterGradleDir.absolutePath)

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.1.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.0" apply false
}

include(":app")
