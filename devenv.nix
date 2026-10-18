{ pkgs, ... }:

# Jhin dev environment: Node.js + pnpm for the TypeScript monorepo.
# The product itself never requires nix; this shell is a convenience only.
{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    pnpm.enable = true;
  };

  languages.typescript.enable = true;
}
