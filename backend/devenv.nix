{ pkgs, config, ... }:

# Dev-окружение backend'а Jhin: Java 21 + Gradle 9.
# Продукт САМ nix не требует (fat jar + gradle wrapper) — devenv нужен только для удобной разработки.
# Для «объединённого» окружения всего монорепо (Java + Flutter сразу) см. ../devenv.nix.
let
  jdk = pkgs.openjdk21;
in
{
  languages.java = {
    enable = true;
    jdk.package = jdk;
    gradle = {
      enable = true;
      package = pkgs.gradle_9;
    };
  };

  env = {
    JDK21_HOME = jdk.home;

    # nix-ld — чтобы нативные бинарники (JVM, нативные либы из maven-зависимостей и т.п.)
    # находили динамический линкер и системные библиотеки вне NixOS FHS.
    NIX_LD = "${pkgs.stdenv.cc}/nix-support/dynamic-linker";
    NIX_LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
      pkgs.stdenv.cc.cc.lib
      pkgs.glibc
      pkgs.zlib
    ];
    LD_LIBRARY_PATH = config.env.NIX_LD_LIBRARY_PATH;

    LOCALE_ARCHIVE = "${pkgs.glibcLocales}/lib/locale/locale-archive";
  };

  # Через wrapper: версия Gradle зафиксирована в gradle/wrapper/gradle-wrapper.properties,
  # а PATH-овый `gradle` из nixpkgs нужен лишь как fallback.
  scripts = {
    start.exec = "./gradlew bootRun";
    test.exec = "./gradlew test";
    build.exec = "./gradlew build";
  };

  enterShell = ''
    echo "Jhin backend devenv (Java 21, Gradle wrapper)"
    java -version
  '';
}