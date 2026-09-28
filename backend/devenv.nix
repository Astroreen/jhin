{ pkgs, config, ... }:

# Dev-окружение backend'а Jhin: Java 21 + Gradle.
# Продукт САМ nix не требует (fat jar + gradle wrapper) — devenv нужен только для удобной разработки.
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

  scripts.start.exec = "gradle bootRun";
  scripts.test.exec = "gradle test";

  enterShell = ''
    echo "Jhin backend devenv"
    java -version
  '';
}
