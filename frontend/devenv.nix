{ pkgs, lib, ... }:

# Dev-окружение frontend'а Jhin: Flutter + JDK 17 (тулинг Android) + Linux-desktop.
# Продукт САМ nix не требует — devenv нужен только для удобной разработки.
# Версии Flutter/Dart и инструментов зафиксированы в devenv.lock.
#
# Для «объединённого» окружения всего монорепо (Flutter + Java 21 сразу) см. ../devenv.nix.
# Настройки VSCode для корня монорепо генерируются там же; .vscode/ внутри frontend/
# нужен только если открывать frontend/ как отдельный workspace.
{
  packages = with pkgs; [
    flutter
    jdk17
    android-tools
    cmake
    ninja
    pkg-config
    gtk3
    pcre
    # Нужен плагину flutter_secure_storage_linux при сборке linux-десктопа
    libsecret
    aapt
  ];

  # Статические переменные окружения (eval-time)
  env = {
    ANDROID_HOME = "${builtins.getEnv "HOME"}/Android/Sdk";
    ANDROID_SDK_ROOT = "${builtins.getEnv "HOME"}/Android/Sdk";
    JAVA_HOME = pkgs.jdk17.home;
    ANDROID_EMULATOR_USE_SYSTEM_LIBS = "1";
    GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${pkgs.aapt}/bin/aapt2 -Dandroid.cmake.path=${pkgs.cmake}/bin/cmake -Dorg.gradle.java.installations.auto-detect=false -Dorg.gradle.java.installations.auto-download=false -Dorg.gradle.java.installations.paths=${pkgs.jdk17.home}";
    GRADLE_USER_HOME = "${builtins.getEnv "PWD"}/.gradle_home";
    PATH = "${pkgs.jdk17}/bin:${pkgs.ninja}/bin:${pkgs.cmake}/bin:${builtins.getEnv "PATH"}";
    LD_LIBRARY_PATH = "${
      lib.makeLibraryPath [
        pkgs.gtk3
        pkgs.pcre
        pkgs.libsecret
        pkgs.zlib
        pkgs.glibc
        pkgs.stdenv.cc.cc
      ]
    }:${builtins.getEnv "LD_LIBRARY_PATH"}";
  };

  # Java-модуль devenv здесь не нужен: JDK 17 ставится напрямую из packages.
  languages.java.enable = false;
  dotenv.enable = true;

  scripts = {
    run.exec = "flutter run";
    runp.exec = "flutter run -d linux";
    runr.exec = "flutter run -d web-server --web-port 8080";
  };

  enterShell = ''
    # Прописываем JDK в flutter config — нужно для android-сборок
    flutter config --jdk-dir ${pkgs.jdk17.home} > /dev/null 2>&1

    # Локальные настройки VS Code для случая, когда открыт именно frontend/.
    # Единственный источник правды для этого файла — этот devenv.nix: Flutter/Dart SDK
    # и JDK берутся из devenv.lock, поэтому после `devenv update nixpkgs` настройки
    # автоматически указывают на новые версии. Для корня монорепо аналог генерирует
    # ../devenv.nix. Файл перезаписывается только при изменении, чтобы не дёргать окно VS Code.
    mkdir -p .vscode
    settings_tmp=$(mktemp)
    cat > "$settings_tmp" <<EOF
{
  "dart.flutterSdkPath": "${pkgs.flutter}",
  "java.import.gradle.java.home": "${pkgs.jdk17.home}",
  "java.server.launchMode": "LightWeight"
}
EOF
    cmp -s "$settings_tmp" .vscode/settings.json || mv "$settings_tmp" .vscode/settings.json
    rm -f "$settings_tmp"

    echo "Jhin frontend devenv (Flutter, JDK 17)"
    flutter --version | head -n 1
  '';
}