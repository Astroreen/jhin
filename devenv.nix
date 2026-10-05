{ pkgs, lib, ... }:

# Jhin v2 — kernel + plugins composite (Java 21 / Gradle 9, Flutter + JDK 17)
#
# Combined dev environment for the whole Jhin monorepo.
#
# Why: the editor and the terminal are usually open at the repository root
# (VSCode -> /Documents/jhin), and both toolchains are wanted right away -
# Java 21 + Gradle (sdk, kernel, plugins) and Flutter + JDK 17 + Android
# (frontend) - without stepping into a subproject.
#
# The toolchains are intentionally re-declared here instead of merging via
# imports: the environments would conflict on variables (JAVA_HOME,
# LD_LIBRARY_PATH, GRADLE_OPTS), so module merging would produce Nix module
# errors. This file is the single source for the root shell.
let
  jdk21 = pkgs.openjdk21;
  jdk17 = pkgs.jdk17;

  # Kernel listener port. The kernel resolves the port as
  # JHIN_KERNEL_PORT (this variable) > config.json `kernel.port` > 8443,
  # so this is the highest-precedence knob short of a `--server.port`
  # argument. 8443 collides with the Nextcloud AIO mastercontainer on this
  # machine, hence the 8444 default here.
  jhinPort = "8444";
in
{
  # Java 21 + Gradle 9 for the composite build (sdk, kernel, plugins/*).
  # `languages.java` sets JAVA_HOME=jdk21 itself, so `gradle`/`java` in the
  # root shell are the 21 toolchain.
  languages.java = {
    enable = true;
    jdk.package = jdk21;
    gradle = {
      enable = true;
      # `pkgs.gradle_9` is only the `gradle` CLI convenience binary for this
      # shell - every real build goes through `./gradlew`, which pins its
      # own distribution per gradle-wrapper.properties (root and
      # frontend/android are both pinned to 9.3.1; AGP 9.1.0 in
      # frontend/android requires Gradle >=9.3.1, so that is the floor for
      # the whole repo). Keep this package on the same 9.x line so a stray
      # `gradle` invocation doesn't spin up yet another daemon version.
      package = pkgs.gradle_9;
    };
  };

  packages = with pkgs; [
    # Frontend: Flutter/Dart + Android/Linux-desktop tooling.
    flutter
    jdk17
    android-tools
    aapt
    cmake
    ninja
    pkg-config
    gtk3
    pcre
    libsecret
    # Shared monorepo dev utilities.
    git
    jq
    curl
  ];

  env = {
    JDK21_HOME = jdk21.home;

    # Kernel listener port (see the `jhinPort` binding above).
    JHIN_KERNEL_PORT = jhinPort;

    # Flutter Android builds (SDK location on the dev machine).
    ANDROID_HOME = "${builtins.getEnv "HOME"}/Android/Sdk";
    ANDROID_SDK_ROOT = "${builtins.getEnv "HOME"}/Android/Sdk";
    ANDROID_EMULATOR_USE_SYSTEM_LIBS = "1";
    GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${pkgs.aapt}/bin/aapt2 -Dandroid.cmake.path=${pkgs.cmake}/bin/cmake -Dorg.gradle.java.installations.auto-detect=false -Dorg.gradle.java.installations.auto-download=false -Dorg.gradle.java.installations.paths=${jdk17.home},${jdk21.home}";
    GRADLE_USER_HOME = "${builtins.getEnv "PWD"}/.gradle_home";

    # nix-ld: native binaries (the JVM, native libraries from Maven
    # dependencies and so on) need the dynamic linker and system libraries
    # outside the NixOS FHS.
    NIX_LD = "${pkgs.stdenv.cc}/nix-support/dynamic-linker";
    NIX_LD_LIBRARY_PATH = lib.makeLibraryPath [
      pkgs.stdenv.cc.cc.lib
      pkgs.glibc
      pkgs.zlib
    ];
    LD_LIBRARY_PATH = lib.makeLibraryPath [
      pkgs.gtk3
      pkgs.pcre
      pkgs.libsecret
      pkgs.zlib
      pkgs.glibc
      pkgs.stdenv.cc.cc
    ];
    LOCALE_ARCHIVE = "${pkgs.glibcLocales}/lib/locale/locale-archive";
  };

  scripts = {
    # Jhin composite build (sdk + kernel + plugins/*): the root Gradle
    # wrapper drives every included build (see settings.gradle).
    jhin-build.exec = "./gradlew build";
    jhin-test.exec = ''
      # Runs `test` in every build of the composite in one Gradle invocation.
      # The root project has no sources and no `test` task of its own, so the
      # standard test entry is the `test` task of each included build (the
      # list mirrors settings.gradle).
      test_tasks=":sdk:test :kernel:test :jhin-plugin-sessions:test :jhin-plugin-security:test :jhin-plugin-llm:test :jhin-plugin-llm-builtin:test :jhin-plugin-agent:test :jhin-plugin-tools-builtin:test :jhin-plugin-mcp:test :jhin-plugin-ui-kit:test :jhin-plugin-ui-default:test :jhin-plugin-reload:test :jhin-plugin-example:test"
      ./gradlew $test_tasks
    '';
    jhin-dist.exec = "./gradlew dist";
    jhin-run.exec = ''
      # Runs the kernel. Prefers the distributable fat jar; until the dist
      # task packs one, falls back to the Gradle boot jar.
      jar=$(ls dist/jhin-kernel-*.jar 2>/dev/null | grep -v -- '-plain\.jar$' | head -1)
      if [ -z "$jar" ]; then
        ./gradlew :kernel:bootJar || exit 1
        jar=$(ls kernel/build/libs/kernel-*.jar 2>/dev/null | grep -v -- '-plain\.jar$' | head -1)
      fi
      if [ -z "$jar" ] || [ ! -f "$jar" ]; then
        echo "jhin-run: kernel jar not found" >&2
        exit 1
      fi
      exec java -jar "$jar" "$@"
    '';
    jhin-cli.exec = ''
      # Runs a kernel CLI subcommand: java -jar <kernel.jar> cli "$@".
      exec jhin-run cli "$@"
    '';
    jhin-plugin.exec = ''
      # Builds one plugin jar and installs it into the JHIN_HOME plugins
      # directory. Usage: jhin-plugin <name>, where <name> is the directory
      # under plugins/ (for example `jhin-plugin example`).
      if [ "$#" -lt 1 ]; then
        echo "usage: jhin-plugin <plugin-name>" >&2
        exit 2
      fi
      if [ ! -d "plugins/$1" ]; then
        echo "jhin-plugin: unknown plugin '$1': no such directory plugins/$1" >&2
        exit 1
      fi
      ./gradlew ":jhin-plugin-$1:jar" || exit 1
      home_plugins="''${JHIN_HOME:-$HOME/.jhin}/plugins"
      mkdir -p "$home_plugins"
      cp plugins/"$1"/build/libs/*.jar "$home_plugins"/
    '';
    jhin-link.exec = ''
      # Builds every plugin jar and symlinks it into the JHIN_HOME plugins
      # directory, so a rebuild is picked up without copying. The template
      # (example) and QA harness (qa-mock-llm) are skipped: neither is part
      # of the product, and example republishes tools-builtin's ToolProvider.
      # Usage: jhin-link
      home_plugins="''${JHIN_HOME:-$HOME/.jhin}/plugins"
      mkdir -p "$home_plugins"

      set --
      for dir in plugins/*/; do
        name=$(basename "$dir")
        [ -f "$dir/build.gradle" ] || continue
        if [ "$name" = "example" ] || [ "$name" = "qa-mock-llm" ]; then
          continue
        fi
        set -- "$@" ":jhin-plugin-$name:jar"
      done
      if [ "$#" -eq 0 ]; then
        echo "jhin-link: no plugin builds found under plugins/" >&2
        exit 1
      fi
      ./gradlew "$@" || exit 1

      for dir in plugins/*/; do
        name=$(basename "$dir")
        [ -f "$dir/build.gradle" ] || continue
        if [ "$name" = "example" ] || [ "$name" = "qa-mock-llm" ]; then
          continue
        fi
        jar=$(ls "$dir"/build/libs/*.jar 2>/dev/null | grep -v -- '-plain\.jar$' | head -1 || true)
        if [ -z "$jar" ]; then
          echo "jhin-link: no jar built for $name" >&2
          continue
        fi
        ln -sfn "$(realpath "$jar")" "$home_plugins/$(basename "$jar")"
        echo "linked $(basename "$jar") -> $jar"
      done

      # Prune stale symlinks for plugins this script no longer links (the
      # template and QA harness), keeping real files untouched.
      for stale in "$home_plugins"/*.jar; do
        [ -L "$stale" ] || continue
        case "$(basename "$stale")" in
          jhin-plugin-example-*|jhin-plugin-qa-mock-llm-*)
            rm -f "$stale"
            echo "unlinked $(basename "$stale")"
            ;;
        esac
      done
    '';
    jhin-home-reset.exec = ''
      # Wipes and recreates a throwaway JHIN_HOME (default: ~/.jhin).
      home="''${JHIN_HOME:-$HOME/.jhin}"
      if [ -z "$home" ] || [ "$home" = "/" ] || [ "$home" = "$HOME" ]; then
        echo "jhin-home-reset: refusing to wipe '$home'" >&2
        exit 1
      fi
      printf "jhin-home-reset: delete '%s' and recreate it empty? [y/N] " "$home"
      read -r answer || answer=""
      case "$answer" in
        y|Y|yes|YES) ;;
        *) echo "jhin-home-reset: aborted"; exit 1 ;;
      esac
      rm -rf "$home"
      mkdir -p "$home/plugins"
      echo "jhin-home-reset: reset '$home'"
    '';

    # Flutter frontend (unchanged).
    frontend-run.exec = "cd frontend && flutter run";
    frontend-runp.exec = "cd frontend && flutter run -d linux";
    frontend-runr.exec = "cd frontend && flutter run -d web-server --web-port 8080";

    # Generates .vscode/settings.json for the root composite build (T41).
    # VSCode reads it as workspace settings; the file is .gitignore-d (the
    # paths change on every update). Written idempotently (mktemp + cmp -s):
    # the file is replaced only when the content differs.
    #
    # The Java importer is pointed at the root composite: the workspace root
    # is a Gradle composite (settings.gradle with the sdk, kernel and eleven
    # plugin included builds), so java.import.gradle.enabled imports that one
    # root build and everything it includes. java.import.exclusions keeps
    # build outputs (**/dist/**, **/.gradle_home/**), the Flutter tree
    # (**/frontend/**) and the scaffold template (**/.opencode/**) out of the
    # Java importer.
    #
    # Three keys here are load-bearing for the composite import and must not
    # be dropped from this template - the file is regenerated on every shell
    # entry, so editing .vscode/settings.json by hand does not survive:
    #   - java.gradle.buildServer.enabled: "on" selects the BSP importer;
    #     the classic Buildship importer resolves every composite-substituted
    #     dependency to nothing.
    #   - gradle.nestedProjects: false stops the Gradle extension from
    #     configuring each plugin directory as its own root build. Outside the
    #     root composite there is no dependency substitution, so internal
    #     coordinates such as com.astroreen:jhin-plugin-qa-mock-llm:0.2.0
    #     escape to Maven Central, 404 and stall the import. The extension
    #     default is already false, but a user-level settings.json may set it
    #     to true, and only the workspace value overrides that.
    #   - **/.opencode/** in java.import.exclusions keeps the scaffold
    #     template (a standalone build with a deliberately unresolvable
    #     apply from) out of the import.
    # See docs/vscode.md for the symptoms each one produces.
    generate-vscode-settings.exec = ''
    mkdir -p .vscode
    settings_tmp=$(mktemp)
    cat > "$settings_tmp" <<EOF
{
  "dart.flutterSdkPath": "${pkgs.flutter}",

  "java.jdt.ls.java.home": "${jdk21.home}",
  "java.import.gradle.java.home": "${jdk21.home}",
  "java.configuration.runtimes": [
    { "name": "JavaSE-21", "path": "${jdk21.home}", "default": true },
    { "name": "JavaSE-17", "path": "${jdk17.home}" }
  ],

  "java.gradle.buildServer.enabled": "on",
  "gradle.nestedProjects": false,
  "java.import.gradle.enabled": true,
  "java.import.gradle.wrapper.enabled": true,
  "java.import.maven.enabled": false,
  "java.project.importOnFirstTimeStartup": "automatic",
  "java.autobuild.enabled": true,

  "java.import.exclusions": [
    "**/node_modules/**",
    "**/.metadata/**",
    "**/archetype-resources/**",
    "**/META-INF/maven/**",
    "**/build/**",
    "**/dist/**",
    "**/.devenv/**",
    "**/.direnv/**",
    "**/.gradle/**",
    "**/.gradle_home/**",
    "**/frontend/**",
    "**/.opencode/**"
  ],

  "java.references.includeDecompiledSources": true,
  "java.contentProvider.preferred": "fernflower",
  "java.implementationCodeLens": "all",
  "java.eclipse.downloadSources": true,
  "java.signatureHelp.enabled": true
}
EOF
    cmp -s "$settings_tmp" .vscode/settings.json || mv "$settings_tmp" .vscode/settings.json
    rm -f "$settings_tmp"
    '';
  };

  enterShell = ''
    # Flutter Android builds need JDK 17 (not 21) - pin it in the Flutter
    # config. Done in enterShell (not at eval time) so the global config is
    # not touched on every evaluation.
    flutter config --jdk-dir ${jdk17.home} > /dev/null 2>&1

    # Devenv scripts
    generate-vscode-settings

    echo "Jhin v2 — kernel + plugins composite (Java 21 / Gradle 9, Flutter + JDK 17)"
    java -version
    flutter --version | head -n 1
  '';
}
