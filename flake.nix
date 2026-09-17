{
  description = "Terraform deployment tooling for herkules";

  # This flake deliberately does NOT describe the whole development environment.
  # Vite+ (`vp`) owns Node and pnpm here (see devEngines in package.json), and it
  # downloads its own runtimes rather than deferring to nix. What `vp` does not
  # manage is the deployment tooling under tools/deploy/cloudflare/terraform, and
  # that is all this flake supplies.
  #
  # Both packages were installed by hand until now:
  #   brew install hashicorp/tap/terraform cloudflare/cloudflare/cf-terraforming
  # They moved here because nix-darwin on this machine runs
  # `homebrew.onActivation.cleanup = "uninstall"`, which uninstalls every formula
  # the generated Brewfile does not name -- so an undeclared brew formula is
  # deleted on the next switch. A project dependency also does not belong in a
  # per-machine Homebrew list (those are GUI casks) in the first place.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    inputs@{ self, nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          # HashiCorp relicensed Terraform from MPL-2.0 to the BUSL (bsl11),
          # which nixpkgs marks unfree and therefore refuses to evaluate unless
          # named. Allow exactly that one package instead of setting
          # allowUnfree = true, so nothing else can slip in unnoticed.
          config.allowUnfreePredicate = pkg: builtins.elem (nixpkgs.lib.getName pkg) [ "terraform" ];
        };
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            # versions.tf sets required_version = ">= 1.10.0" (the floor for the
            # S3 backend's use_lockfile in backend.tf), and nixpkgs' terraform is
            # comfortably above it.
            #
            # cf-terraforming reads the provider schema out of an initialised
            # working directory, so it is only useful next to terraform.
            packages = [
              pkgs.terraform
              pkgs.cf-terraforming
            ];
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt-rfc-style);
    };
}
