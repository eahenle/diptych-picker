# Dependency update policy

## Reproducible installs

`package-lock.json` is the authoritative dependency graph for development, CI,
and production builds. Use `npm ci` when reproducing the repository state. Do
not run an unreviewed install as part of feature work or commit lockfile changes
that are unrelated to the branch's purpose.

`package.json` and `package-lock.json` both pin exact direct dependency
versions. The manifest makes review diffs explicit, while the lockfile remains
the authoritative complete graph. Security overrides must name the patched
transitive version and be removed when the direct dependency adopts it.

## Update cadence and scope

- Review dependency updates monthly and promptly when a relevant security
  advisory requires action.
- Make dependency updates in a dedicated maintenance branch and pull request.
- Update coupled packages together, especially Next.js, React, React DOM, their
  type packages, and `eslint-config-next`.
- Keep unrelated product or refactoring changes out of the update pull request.
- Inspect both manifest and lockfile diffs. Document notable runtime, build,
  browser-support, or migration implications in the pull request.

Use an explicit install command for packages being advanced, then let npm update
the lockfile. Avoid deleting or regenerating the lockfile merely to obtain newer
transitive versions.

## Required validation

Every dependency update must pass:

```sh
npm ci
npm run check
npm run build
npm run test:e2e
npm audit --omit=dev
```

Launcher, mailbox-protocol, production compilation, and Chromium coverage are
all release gates. Production dependencies must have no high or critical audit
findings. If an update changes generated `next-env.d.ts` content, restore the
repository's tracked development reference before committing.

## Merge and rollback

Merge only after both GitHub Actions jobs pass. Keep the dependency update in a
single reviewable merge so reverting that merge restores the prior manifest and
lockfile together. Do not work around a failing update by weakening validation;
defer or pin the incompatible package and record the reason in the pull request.
