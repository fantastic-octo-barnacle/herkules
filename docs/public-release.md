# Public-release preparation

This is a preparation record, not authorization to change repository visibility.
The application repository is the publication candidate; production infrastructure
remains in `herkules-infra`.

## Prepared in the cleanup branch

- Original code is licensed under `MIT OR Apache-2.0`; third-party exceptions are
  recorded in `THIRD_PARTY_NOTICES.md`. Package-manager publication stays disabled.
- Application Actions use commit hashes, with weekly grouped Dependabot updates.
- CI scans reachable Git history using checksum-pinned Gitleaks and redacted output.
  Application manifests require that scan as well as the build and test checks.
- `.gitleaks.toml` documents narrow exceptions for test vectors, deterministic test
  credentials, one historical public encryption key, and a prose false positive.
  Review changes to these exceptions as part of code review.
- Documentation-only changes skip application image publication.
- Unused OAuth management mutations are disabled. Login redirect regression tests
  cover the backslash/whitespace cases fixed during the Feishu work.

## Remaining publication decisions and checks

- Review the remaining security findings in `KNOWN_ISSUES.md`, including the
  last-administrator concurrency guard. Do not delete the backlog to make the
  repository appear ready. These findings have not all been revalidated here.
- Choose whether to retain history, selectively remove former infrastructure
  paths, or publish a clean snapshot. The current branch does not rewrite history.
  The old monorepo history includes production topology and operational notes.
- Review old PRs, issues, attachments, releases, Actions logs and artifacts.
  Rewriting a branch does not remove those surfaces or hidden PR references.
  The initial secret scan covers local reachable Git history, not a complete
  audit of all GitHub-hosted content or a guarantee that no secret exists.
- Before deleting hosted history or artifacts, preserve any records required for
  rollback and release provenance in the private infrastructure repository.
  The infrastructure baseline still references an old application source commit
  and OCI release. Do not delete packages needed by that rollback.
- Review fork-PR workflow settings, require reviewed changes for publishing jobs,
  and enable private vulnerability reporting when the repository is public.
- Check package visibility separately. A public source repository does not require
  a decision here to publish runtime packages or change npm package privacy.

Keep GitHub secrets and server-owned `.env` files outside the source tree. A clean
scanner result does not replace the hosted-content and security reviews above.

## Repeat the local scan

With Gitleaks 8.30.1 installed, run from the repository root:

```sh
gitleaks git --redact --log-opts="--all"
```

For a current-tree audit, scan a temporary export of tracked files instead of the
working directory: local ignored `.env` files are intentionally private and are not
part of the material to publish. Never upload an unredacted scanner report.

GitHub documents the other surfaces exposed by a visibility change in
[Setting repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
