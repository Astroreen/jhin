{ pkgs, lib, ... }:

# «Объединённое» dev-окружение всего монорепозитория Jhin.
#
# Зачем: редактор и терминал часто открыты в корне репо (VSCode → /Documents/jhin),
# и хочется сразу иметь оба тулчейна — Java 21 + Gradle (backend) и
# Flutter + JDK 17 + Android (frontend) — без перехода в подпроект.
#
# backend/ и frontend/ сохраняют собственные devenv.nix для узкой работы.
# Тулчейны здесь намеренно описаны заново: env-переменные подпроектов конфликтуют
# (JAVA_HOME, LD_LIBRARY_PATH, GRADLE_OPTS), поэтому «слияние через imports» дало бы
# ошибки Nix-модулей. Единый источник для этого корня — этот файл.
let
  jdk21 = pkgs.openjdk21;
  jdk17 = pkgs.jdk17;
in
{
  # Backend: Java 21 + Gradle 9. `languages.java` сам выставляет JAVA_HOME=jdk21,
  # поэтому в корне `gradle`/`java` — это 21 (удобно для backend).
  languages.java = {
    enable = true;
    jdk.package = jdk21;
    gradle = {
      enable = true;
      package = pkgs.gradle_9;
    };
  };

  packages = with pkgs; [
    # Frontend: Flutter/Dart + Android/Linux-desktop тулинг (см. frontend/devenv.nix).
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
    # Общие dev-утилиты монорепо.
    git
    jq
    curl
  ];

  env = {
    JDK21_HOME = jdk21.home;

    # Flutter Android-сборки (см. frontend/devenv.nix).
    ANDROID_HOME = "${builtins.getEnv "HOME"}/Android/Sdk";
    ANDROID_SDK_ROOT = "${builtins.getEnv "HOME"}/Android/Sdk";
    ANDROID_EMULATOR_USE_SYSTEM_LIBS = "1";
    GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${pkgs.aapt}/bin/aapt2 -Dandroid.cmake.path=${pkgs.cmake}/bin/cmake -Dorg.gradle.java.installations.auto-detect=false -Dorg.gradle.java.installations.auto-download=false -Dorg.gradle.java.installations.paths=${jdk17.home},${jdk21.home}";
    GRADLE_USER_HOME = "${builtins.getEnv "PWD"}/.gradle_home";

    # nix-ld — чтобы нативные бинарники (JVM, нативные либы из maven-зависимостей и т.п.)
    # находили динамический линкер и системные библиотеки вне NixOS FHS.
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
    backend-run.exec = "cd backend && ./gradlew bootRun";
    backend-test.exec = "cd backend && ./gradlew test";
    backend-build.exec = "cd backend && ./gradlew build";
    frontend-run.exec = "cd frontend && flutter run";
    frontend-runp.exec = "cd frontend && flutter run -d linux";
    frontend-runr.exec = "cd frontend && flutter run -d web-server --web-port 8080";

    generate-vscode-settings.exec = ''
      # Генерируем .vscode/settings.json с актуальными nix store-путями.
    # VSCode читает его как workspace-настройки; файл в .gitignore (пути меняются при update).
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
    "**/.devenv/**",
    "**/.direnv/**",
    "**/.gradle/**",
    "**/.gradle_home/**",
    "**/frontend/**"
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
    # Android-сборкам Flutter нужен JDK 17 (не 21) — фиксируем его в конфиге Flutter.
    # Делается в enterShell (не eval-time), чтобы не трогать глобальный конфиг при каждом eval.
    flutter config --jdk-dir ${jdk17.home} > /dev/null 2>&1

    # Devenv scripts
    generate-vscode-settings

    echo "Jhin monorepo devenv (Java 21 + Gradle 9, Flutter + JDK 17, Android tools)"
    java -version
    flutter --version | head -n 1
  '';
}
