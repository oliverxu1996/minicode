import manifest from "../package.json" with { type: "json" }

/**
 * The MiniCode product version.
 *
 * Read from this package's manifest rather than declared as a separate
 * constant: the bundler inlines the JSON, so the value survives into the
 * compiled standalone binary and there is no second number to keep in sync.
 *
 * The published product identity (`minicode` on npm, the release tag, the
 * changelog) is `packages/cli/package.json`, which is a different manifest —
 * `cli.test.ts` asserts the two agree so they cannot drift silently.
 */
export const MINICODE_VERSION: string = manifest.version
