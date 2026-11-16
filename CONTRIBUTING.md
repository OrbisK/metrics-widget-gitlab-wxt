# Contributing

See the [README](README.md) for what the extension does and the endpoint chain it walks to find
reports. This file covers working on it.

## Development

```sh
pnpm dev              # Chrome, with HMR — needs an interactive terminal
pnpm dev:firefox
pnpm compile          # vue-tsc typecheck
pnpm test             # vitest
pnpm build            # pnpm build:firefox for the Firefox target
pnpm zip
```

`pnpm compile` and `pnpm test` are what CI gates on, so run both before opening a pull request.

### Testing against a real instance

`pnpm dev` launches Chrome with a **fresh temporary profile**, which is not signed in to your
GitLab. An anonymous request to a merge request URL redirects to `/users/sign_in`, so the extension
sees a path that is not a merge request and correctly does nothing. For anything involving real
data, use the production build in the profile where your GitLab session lives:

```sh
pnpm build
# chrome://extensions -> Developer mode -> Load unpacked -> .output/chrome-mv3
```

Then on your instance: extension icon → **Enable on this instance** → **Reload tab**.

Note also that `pnpm dev` waits on stdin for its `o + enter` shortcut, so it exits immediately if
started without an interactive terminal.

## Layout

| Path | What it does |
| --- | --- |
| `entrypoints/gitlab-mr.content/` | Content script: detects the MR page, orchestrates the scan, mounts the widget |
| `entrypoints/background.ts` | Registers the content script for user-added instances |
| `entrypoints/popup/`, `entrypoints/options/` | Instance list and display settings |
| `lib/gitlab-page.ts` | MR URL parsing and relative-URL-root handling |
| `lib/gitlab-api.ts` | The endpoint chain in the README, artifact download, gunzip |
| `lib/metrics.ts` | Parses the OpenMetrics text report, pools several jobs' reports, diffs head against base |
| `lib/scan.ts` | Three-phase scan: discover, download, then compare with the target branch |
| `lib/anchor.ts` | Where the widget is grafted onto the page |
| `components/MetricsWidget.vue` | The widget itself; `MetricsWidget.test.ts` renders it with `vue/server-renderer` |

`lib/gitlab-api.ts`, `lib/anchor.ts`, the popup, the options page shell, the background registration
and the release pipeline are shared in spirit with
[security-widget-gitlab-wxt](https://github.com/OrbisK/security-widget-gitlab-wxt); a fix to one is
usually worth porting to the other.

## Injection point

The widget is inserted **before `#js-vue-mr-widget`**, the element GitLab's own MR widget Vue app
mounts into. That puts it at the top of the widget stack while keeping our node in the
server-rendered parent, which Vue does not manage and so will not patch away. `lib/anchor.ts` falls
back through `#widget-state`, `.mr-state-widget`, `.merge-request-overview` and
`.merge-request-details` for older or restructured layouts.

Styling is deliberately *not* in a shadow root: the widget reads GitLab's own theme tokens
(`--gl-background-color-section` and friends, GitLab 17+) so it matches light and dark themes, with
hardcoded fallbacks for older versions. Every class is `glmw-` prefixed to avoid collisions.

## Not overclaiming

Two invariants the tests in `lib/metrics.test.ts` pin down:

- a head metric whose job's base report could not be read is `uncompared`, never `new`;
- a base metric is only `removed` once this merge request's run of the job that reported it has
  finished and its report was readable.

## Releasing

Releases are driven by [uppt](https://github.com/danielroe/uppt) from Conventional Commits. Nobody
edits a version by hand; `.github/workflows/release.yml` runs three jobs across three triggers:

| Trigger | Job | What happens |
| --- | --- | --- |
| push to `main` | `pr` (`uppt/pr`) | Parses commits since the last tag, opens or updates a draft `release/vX.Y.Z` PR bumping `version` in `package.json` |
| that PR merging | `release` (`uppt/release`) | Tags the squash commit, cuts a GitHub release from the PR body, dispatches this workflow on the tag |
| `workflow_dispatch` on a `v*` tag | `assets` | Type check, test, zip both targets, attach the zips to the release (store submission is currently disabled) |

`assets` takes the place of uppt's own `pack` and `publish` jobs — this is an extension, not an npm
package, so it submits to the extension stores instead of a registry. It is modelled on the submit step
[unsight.dev](https://github.com/danielroe/unsight.dev/blob/main/.github/workflows/release-extension.yml)
uses for its extension, wired to uppt's tag dispatch instead of a `package.json` path filter.

Two consequences of Conventional Commits worth knowing: only `feat`/`fix`/`perf`-style types produce
a release (`chore(deps)` is ignored outright, so dependency bumps no longer look like releases), and
while the major version is `0`, uppt demotes bumps one level — a `feat:` is a patch, a breaking
change is a minor.

The release PR body is the changelog, and it is editable: anything you write above the
`## 👉 Changelog` heading survives regeneration and lands in the GitHub release notes.

Rebuilding the assets for an existing tag is **Run workflow** on this workflow with the `v*` tag
selected; the zips are re-uploaded with `--clobber`.

### Store submission

Store submission is **disabled** for now: the extension is distributed only through the zips
attached to each GitHub release. Both submit steps, their secrets in the job `env`, and the
Firefox row of the job summary are commented out in `release.yml`. The setup below describes how
it works once re-enabled.

| Store | Secrets | Status |
| --- | --- | --- |
| Firefox Add-ons | `FIREFOX_EXTENSION_ID`, `FIREFOX_JWT_ISSUER`, `FIREFOX_JWT_SECRET` | commented out |
| Chrome Web Store | `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` | commented out |

Submission runs *after* the release upload, so a rejected submission still leaves installable zips
behind. Each step is gated on its secrets being present (`if: env.FIREFOX_JWT_ISSUER != ''`, with the
secrets read into the job `env` because `secrets` is not available in `if`), so the job stays green
on a repo or fork without them. The job summary reports each store's outcome.

Each Firefox version gets release notes. `wxt submit` has no option for them, so
`patches/publish-browser-extension@4.0.5.patch` (applied by pnpm through `pnpm-workspace.yaml`) adds
a `FIREFOX_RELEASE_NOTES` env var, which sets the new version's notes once it is created.
`scripts/release-notes.mjs` builds them from the GitHub release body, keeping only the changelog
sections and rewriting headings and inline code, which AMO's limited Markdown does not render. When
`wxt` bumps `publish-browser-extension`, the patch has to be ported with `pnpm patch` or pnpm will
fail to install.

To re-enable a store, add its secrets and uncomment its env entries and its `Submit to …` step
(and, for Firefox, restore the `FIREFOX_OUTCOME` summary row).

`pnpm exec wxt submit init` walks through obtaining the credentials, and `--dry-run` checks them
without uploading anything. `FIREFOX_EXTENSION_ID` has to match the gecko id in `wxt.config.ts`
(`metrics-widget-for-gitlab@local`), which is the id the AMO listing is registered under.

Two repository settings uppt needs: **Allow GitHub Actions to create and approve pull requests**
under Settings → Actions → General, or `uppt/pr` gets a 403 when opening the release PR. The `npm`
environment and trusted-publisher setup from uppt's README do not apply — there is no publish job.

## Store listing requirements

GitLab's [trademark guidelines](https://handbook.gitlab.com/handbook/marketing/brand-and-product-marketing/brand/brand-activation/trademark-guidelines/)
govern what a third-party extension may be called. A Chrome Web Store or AMO listing must therefore:

- keep a name that does not lead with "GitLab" and uses only the `… for GitLab` or `GitLab
  Compatible` form — hence **Merge Request Metrics Widget for GitLab**, which also fits AMO's
  50-character name limit;
- carry the non-affiliation notice at the top of the README in the listing's overview text;
- use no GitLab logo, logomark or wordmark, in the icon or the screenshots. The current
  `public/icon/*.png` is a generic puzzle piece.
