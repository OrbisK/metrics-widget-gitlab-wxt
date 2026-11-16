# Merge Request Metrics Widget for GitLab

> [!WARNING]
> Early work in progress. Expect breaking changes and rough edges on GitLab layouts it has not been
> tried against. Bug reports with a `console.debug` trail are welcome.

> [!IMPORTANT]
> This extension is not affiliated, endorsed, sponsored, or approved with or by GitLab Inc.
> GitLab is a trademark of GitLab Inc.

A browser extension that shows the [metrics report](https://docs.gitlab.com/ci/testing/metrics_reports/)
your **merge request** pipeline already produces, compared with the target branch, on the merge
request page.

## Why

Your pipeline already measures things about a change, such as bundle size, test count, coverage
and memory usage. Declared as `artifacts:reports:metrics`, those numbers are stored with the job as
a `metrics.txt` file. Seeing them while you review means opening the job and downloading the file,
and comparing them with the target branch means doing that twice and diffing by hand.

This extension does that step for you. With your existing session, it reads the merge request's
metrics file and the target branch's, then shows the difference above the merge widget. It only
reads files you can already download yourself, through the same route as the job page's "Download"
button, and it changes nothing on GitLab.

## Install

> [!NOTE]
> No store listing yet, so there is no auto-update — you reinstall to upgrade.

Grab the zip for your browser from the [latest release](../../releases/latest) and load it unpacked:

- **Chrome** — unzip it, then `chrome://extensions` → Developer mode → **Load unpacked**
- **Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**

`gitlab.com` works immediately. For a self-managed instance, open the extension icon on that
instance and choose **Enable on this instance**, then reload the tab.

## Setting up a metrics report

```yaml
metrics:
  stage: test
  script:
    - echo "bundle_size_kb $(du -k dist/app.js | cut -f1)" > metrics.txt
    - echo "test_count 128" >> metrics.txt
  artifacts:
    reports:
      metrics: metrics.txt
```

The file is the [OpenMetrics](https://openmetrics.io/) text format: one `name value` per line.
`#` lines are skipped, a label set is part of the name (`requests{method="get"}` and
`requests{method="post"}` are two metrics), and a trailing timestamp is ignored.

## What it shows

```
Metrics report: 1 changed, 1 new
Pipeline #123 · Compared with pipeline #120 on main (merge base, 36d0e01d) · 4 unchanged

CHANGED
bundle_size_kb      412 → 4122      +3,710 (+900.5%)
NEW
lint_warnings       2               New
```

- **Changed** — the value differs from the target branch's. Values are compared as written, the way
  GitLab's own widget does, so a non-numeric metric (`status passing`) still shows as changed, just
  without a delta. Deltas are not coloured as good or bad: whether up is better depends on the metric.
- **New** / **Removed** — present on only one side.
- **Unchanged** — counted in the header, and listed only with **Show unchanged metrics** turned on.
- **Not compared** — the target branch's report from the same job could not be read (usually an
  expired artifact). Counting those as new would be a guess.

Several jobs can each declare a metrics report; they are pooled into one set, as GitLab does. A
metric missing from this merge request is only called removed once this merge request's run of the
job that reported it has finished.

Without a target branch to compare against — the comparison is off, or no finished pipeline on the
target branch has a readable report — every metric is listed with its current value and the header
says why.

A filter box narrows and sorts the list with a small query language, completed as you type:

| Term                               | Meaning                                                                    |
|------------------------------------|----------------------------------------------------------------------------|
| `bundle`, `*_bytes`                | the metric name (labels included) contains the word, or matches the glob   |
| `name:`, `job:`                    | the same, against the metric name or the job that reported it              |
| `is:changed,new`                   | the status: `changed`, `new`, `removed`, `unchanged`, `uncompared`         |
| `-term`, `key:!value`              | excludes what the term matches                                             |
| `change:>2%`                       | relative change of more than 2%, either way (`>=`, `<`, `<=`, `=` too)     |
| `change:>+2%`, `change:<-2%`       | with a sign: grew by more than 2%, or dropped by more than 2%              |
| `delta:>=1000`                     | the same for the absolute change, in the metric's own unit                 |
| `sort:change`                      | relative change (%), biggest increase first                                |
| `sort:abs-change`, `sort:abs-delta`| size of the change, either way, biggest first                              |
| `sort:delta`                       | absolute change, biggest increase first                                    |
| `sort:value`, `sort:previous`      | the new or the old value (`new`, `old` work too)                           |
| `sort:name`                        | A to Z                                                                     |

A `change:` or `delta:` threshold is meant for hiding noise, so it only judges rows that have that
number: new, removed and non-numeric metrics, and changes from zero (no percentage), stay listed.
Several thresholds all have to hold, so `change:>1% change:<50%` is a range.

Add `-asc` or `-desc` to a sort to flip it (`sort:change-asc` lists the biggest drops first);
several sorts break ties in order. Rows without a number to sort by go last. Each section is
filtered and sorted on its own. The query is not stored, and the header keeps describing every
metric.

## How it finds the reports

Report artifacts are not part of the artifacts archive, so the Job Artifacts API returns `404` for
them. They *are* served by the web download route, keyed by artifact type:

```
GET /:namespace/:project/-/jobs/:job_id/artifacts/download?file_type=metrics
```

The chain the content script walks:

1. `GET {project}/-/merge_requests/{iid}/cached_widget.json` → head pipeline id, target project id.
2. `GET {project}/-/merge_requests/{iid}.json?serializer=widget` → the project's full path, which
   locates `/api/v4` on instances served under a relative URL root.
3. `GET /api/v4/projects/{id}/pipelines/{pipeline}/jobs` → jobs with a `metrics` artifact. Child
   pipelines are followed via `.../bridges`, one level deep by default and up to three from the
   options page.
4. `GET {job.web_url}/artifacts/download?file_type=metrics` per report, gunzipped in the browser
   when the gzip magic bytes are present.

Then, for the target branch comparison:

5. `GET /api/v4/projects/{id}/merge_requests/{iid}` → `target_branch` and `diff_refs.base_sha`.
6. `GET /api/v4/projects/{id}/pipelines?sha={base_sha}` and `?ref={target_branch}`, newest first,
   keeping only finished pipelines.
7. Steps 3 and 4 again for the first candidate pipeline that has a readable report — the merge base
   first, then the target branch's latest — three tried by default, up to ten from the options page.

While the page stays open the widget keeps itself current, every 30 seconds by default (adjustable,
or off). While the pipeline runs, steps 1–3 are repeated and only reports of jobs that finished
since are downloaded. Once it has finished, only step 1 is repeated, half as often, to notice a push.
Background tabs are not checked. The refresh button does all of it at once and re-reads the target
branch.

All requests are same-origin from the content script, so the `_gitlab_session` cookie rides along.

When GitLab answers `429 Too Many Requests`, every request stops until its `Retry-After` has passed
(doubling from a minute when it gives none, never more than an hour). Polling waits for it, the
widget says until when, and a report or comparison the limit cut short is fetched again afterwards.
Rate limits on gitlab.com are per IP for signed-out traffic, so being signed in helps.

## Permissions and privacy

`gitlab.com` is granted at install time. Self-managed instances are opt-in: open the popup on your
instance and choose **Enable on this instance**, or add it from the options page.

> [!NOTE]
> Nothing is sent anywhere — reports are read from your instance and rendered locally. See
> [PRIVACY.md](PRIVACY.md).

## Troubleshooting

The decision-level trail is logged at `console.debug` with a `[gitlab-metrics]` prefix, which Chrome
hides behind the console's **Verbose** level — switch that on and reload.

| Console output | Meaning |
| --- | --- |
| *(nothing at all)* | The content script never ran. Check the popup's **Diagnostics** section, then **Repair registration**. |
| `inactive: not a merge request page` | The path is not `/-/merge_requests/:iid` — usually a redirect to the sign-in page. |
| `inactive: this merge request has no head pipeline` | Nothing to read. |
| `inactive: pipeline N has no metrics report artifacts` | The preceding line lists every job and its artifact types. |
| `could not read metrics from job X#N: expired — …` | The job lists the artifact but the download 404s. |
| `no comparison: …` | The metrics render without a comparison; the message says which step gave up. |
| `GitLab is rate limiting requests (…); pausing until …` | A 429; the name in brackets is GitLab's `RateLimit-Name`. Nothing is requested until then. |
| `compared with pipeline N (merge-base\|target-branch)` | Followed by the changed / new / removed / unchanged tally. |

**Settings → Log each step to the page console** adds a line per HTTP request on top of that.

## Known limits

- Values are compared as strings, like GitLab's widget: `1.0` and `1` count as a change (with a delta
  of `±0`).
- The comparison needs a *finished* pipeline on the target branch whose metrics artifact has not
  expired.
- Only the first 500 jobs of a pipeline are scanned (5 pages of 100).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, layout and release process.
