---
name: release
description: Cut a Longhand release. Bumps versions, syncs docs and snippets, tags vX.Y.Z, pushes, and verifies consumption on npm, SwiftPM, JitPack, and Gradle. Use when asked to release, tag, bump, or publish a version of this repo.
---

# Cutting a Longhand release

A release here is a git tag, nothing more: there is no registry publish.
One annotated `vX.Y.Z` tag serves all four consumption paths at once
(npm git installs, SwiftPM, JitPack Maven coordinates, Gradle source
dependencies). The tag must land on a commit where all three ports pass
their suites, because a pinned seed is advertised as a portable take.

## 1. Preflight

Work on a clean `main` (`git status` clean, up to date with origin).

Fixtures first if this clone has never generated them (the golden files
are gitignored): `pnpm gen:goldens && pnpm gen:weights`.

Run all three suites. CI only covers TypeScript, so the Swift and Kotlin
runs are release gates that exist only locally:

```sh
pnpm typecheck && pnpm test
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"  # any JDK 17+
./gradlew test
swift test -c release        # release build: debug runs the engines ~20x slower
```

Also confirm the JitPack path still builds without fixtures:
`./gradlew publishToMavenLocal -x test` (this is the exact command
jitpack.yml runs). Spot-check the weights are inside the engine JARs:
`unzip -l ~/.m2/repository/com/trylonghand/ink-graves/<ver>/ink-graves-<ver>.jar | grep bin`.

## 2. Pick the version

Semver, and below 1.0 the minor version is the compatibility boundary:
SwiftPM's `from: "0.1.0"` accepts 0.1.x but never 0.2.0. So:

- patch: fixes and additions that do not change what a pinned seed draws
- minor: anything that changes generated strokes for an existing seed
  (quantization, priming, sampling changes), or breaks an API

## 3. Bump versions

Version strings live in six places; keep them identical:

1. `package.json` (root) `"version"`
2. `packages/ink-kotlin/ink-core/build.gradle.kts` `version = "..."`
3. `packages/ink-kotlin/ink-graves/build.gradle.kts`
4. `packages/ink-kotlin/ink-calligrapher/build.gradle.kts`
5. `packages/ink-kotlin/ink-render/build.gradle.kts`
6. Optional, only when the demo changed: `versionName`/`versionCode` in
   `packages/ink-kotlin/example/app/build.gradle.kts`

`Package.swift` carries no version on purpose; SwiftPM reads the tag.

## 4. Sync docs and emitted snippets

Policy: the README and the site deliberately show branch-tracking
installs (`github:tmarkovski/longhand`, `branch: "main"`,
`main-SNAPSHOT`) so examples never go stale. Do not rewrite them to the
new tag. What to check instead:

- If any doc names a concrete old tag, update it. Grep:
  `grep -rn "v0\." README.md docs/ apps/web/src/snippets.ts apps/web/src/BuildPage.tsx`
- The places that define coordinates, should the policy ever change:
  `apps/web/src/snippets.ts` (`SWIFT_DEPENDENCY`, `KOTLIN_GROUP`, the
  `main-SNAPSHOT` strings in `kotlinSnippet`) and the
  `KOTLIN_GRADLE_SNIPPET` / `SWIFT_PACKAGE_SNIPPET` blocks in
  `apps/web/src/BuildPage.tsx`, plus the README "Use it in your app"
  section and `docs/android.md`.

Run `pnpm typecheck` again if snippets changed.

## 5. Commit, tag, push

Commit in the repo's log style: short sentence-case summary line, no
attribution or Co-Authored-By lines, no em-dashes.

```sh
git add -A && git commit -m "Release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main --follow-tags
```

The push to main also triggers CI and the Pages deploy
(`.github/workflows/deploy.yml`), so the site ships with the release.

## 6. GitHub release notes (optional but nice)

```sh
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
```

Write the notes in the user's voice: plain prose, no em-dashes, no
generated-with footers. Lead with what changed for takes (did strokes
change for pinned seeds?), then SDK-facing changes per platform.

## 7. Verify consumption

- npm: `cd $(mktemp -d) && npm install github:tmarkovski/longhand#vX.Y.Z`
  (needs git access while the repo is private).
- SwiftPM: point a scratch Package.swift or the Example app at
  `from: "X.Y.Z"` and `swift package resolve`.
- JitPack: only works once the repo is public (or with a JitPack auth
  token). Prewarm and check the build:
  `curl -s https://jitpack.io/com/github/tmarkovski/longhand/ink-core/vX.Y.Z/ink-core-vX.Y.Z.pom`
  and on failure read
  `https://jitpack.io/com/github/tmarkovski/longhand/ink-core/vX.Y.Z/build.log`.
  Remember JitPack coordinates carry the literal tag: `:vX.Y.Z`, with
  the `v`.
- Gradle source dependencies: a consumer declaring
  `com.trylonghand:ink-core:X.Y.Z` matches the `vX.Y.Z` tag
  automatically.

## Gotchas

- `packages/*/test/goldens/` are gitignored. Nothing a consumer builds
  may depend on them; that is why jitpack.yml skips tests. If a new test
  needs a fixture, it reads it via the `longhand.repoRoot` system
  property and fails with a regeneration hint, same as the Swift suite.
- `"private": true` in the root package.json only blocks `npm publish`;
  git installs are unaffected. Leave it.
- The Kotlin build needs JDK 17+; Android Studio's JBR (path above) is
  the known-good one on this machine. The Android SDK and emulator are
  not needed for a release.
