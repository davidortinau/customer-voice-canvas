# Customer Voice Canvas

An export-first survey viewer for the GitHub Copilot App. It uses one renderer
for different Customer Voice surveys. Confirm question types, scales, scoring,
filters, and follow-up consent in a reusable survey profile.

**Status:** both export journeys are implemented and tested: the .NET Developer
Survey and MAUI HaTS. The direct connector has synthetic API and browser checks,
but no real Microsoft sign-in or tenant read has been performed. The packaged
release is installed locally. Marketplace CLI installation and update, and
native Canvas discovery and opening in a new App chat, have passed. App
Customize install/update controls and a full App restart remain untested.
The existing MAUI viewer is not changed. This is an early private release,
not a fully validated live connector.

## Install and open a survey

The packaged release supports **macOS on Apple Silicon**. The Copilot App
supplies Node. The plugin includes its survey reader and dependencies. You do
not need to clone the source, build the plugin, or run Python or npm setup
commands.

1. In the Copilot App, add `davidortinau/customer-voice-canvas` as a
   marketplace in **Customize**. Your GitHub account needs access to this
   private repository.
2. Select **customer-voice-canvas** and install it.
3. Start a new session so the runtime loads the installed plugin. Ask:
   **Open Customer Voice.**
4. Select **Browse files**, choose an export, then select **View report**.
   The suggested defaults open the report without a mapping form. Use
   **Review profile** if a setting needs a change or you want to save it.
5. After replacing the export, click **Refresh data**. No background refresh
   changes your reading position.

After a plugin update, start a new chat and open Customer Voice there.
An existing chat can keep its old provider process. Reloading its web page
does not restart that process. The provider keeps its renderer files in
memory so a later install cannot mix a new interface with old request handlers.

For updates, use the App's update control or the CLI command below, then start
a new session. Saved profiles and reading settings stay outside the installed
plugin and are not replaced by an update.

```bash
copilot plugin marketplace add davidortinau/customer-voice-canvas
copilot plugin install customer-voice-canvas@customer-voice-canvas
# Later:
copilot plugin update customer-voice-canvas@customer-voice-canvas
```

The marketplace points to the built `stable` branch, not source on `main`.
Do not install the source repository directly with `copilot plugin install
davidortinau/customer-voice-canvas`; that bypasses the packaged marketplace
entry and requires the developer setup below.

## Run from source

Requires Node.js 22+ and Python 3.10+ with pandas and openpyxl.

```bash
python3 -m pip install -r requirements.txt
npm ci --prefix extensions/customer-voice --ignore-scripts
node extensions/customer-voice/server.mjs --source "/full/path/survey.xlsx"
```

Open the printed loopback URL in a browser or the Copilot App Browser Canvas.
The fragment is a private access token. Do not share that URL outside the local
session. The server binds to `127.0.0.1` only.

The extension uses the Copilot SDK supplied by the runtime. Do not install or
vendor `@github/copilot-sdk`. To use another Python executable, set
`CUSTOMER_VOICE_PYTHON` to its full path. The default launcher search uses
`python3`/`python` on macOS and Linux, and `py -3`/`python`/`python3` on Windows.
Only macOS has been exercised.

## Local plugin development

```bash
copilot --plugin-dir "$PWD" plugin list
```

Use `--plugin-dir` for source development. The marketplace entry deliberately
uses the checked remote package, even when its catalog is opened locally.
Native App installation is a separate acceptance check; CLI discovery alone
does not prove that the App can render the registered Canvas.

The declared Canvas is `customer-voice-survey`. Its open input accepts
`source` (full local export path) or `surveyId` (a saved profile ID). Its
`scope`, `surveys`, and `answers` actions support chat analysis without
automatically exposing contacts. `answers` returns the complete current cohort
for the requested text-question ID, not only the visible page.

## Import and reuse

1. Select **Open export**, then **Browse files**. The native macOS file dialog
   selects a CSV/XLSX export. Cancel keeps the previous selection.
   You can still enter a path, sheet, or header row
   if needed. The viewer references the file. It does not copy or upload it.
2. Select **View report** to use suggested defaults. This quick view does not
   save a profile or reading settings. It labels the settings as suggestions.
   Private contacts stay locked until you confirm the consent mapping.
3. Use **Review profile** at any time to change settings and save them.
   Review uses the loaded snapshot, not an unexpected new file read. Check
   field roles, ordered choices, positive choices, exclusions, population
   eligibility, and follow-up consent. **Inspect export** still opens the
   mapping form first. That form also has **View report with defaults**.
4. Use **Refresh data** after replacing the file with a complete updated
   export. There is no polling, file watcher, or background sync.
5. To use a new filename, select **Open export**, choose the saved survey
   profile, and confirm the explicit source change.

Profiles are stored under
`$COPILOT_HOME/extensions/customer-voice-canvas/artifacts/`, with `~/.copilot`
as the default home. They are outside the installed plugin and source checkout.
Profiles contain question mappings, approved choices, a local file reference,
and a private pseudonym key. Response rows are not persisted by the viewer.
Profile files use owner-only permissions on systems that support them.
Non-sensitive reading settings are saved separately under `artifacts/views/`,
using the survey identity. Question selection, answer page, population, filters,
and scroll position can therefore survive a new server port. Search terms stay
in page memory only and are not saved to disk or browser storage.

Use your own private durable folder for exports. A session attachment can
disappear with that session. The viewer does not silently copy attachments.
Do not put raw exports in this repository. CSV and XLSX files are ignored by
default.

The bundled .NET Developer Survey profile is a proposal, not an authoritative
survey definition. It identifies known scale blocks, flags missing parent
wording, and leaves uncertain fields for review. Generic imports use observed
values and header wording. A semicolon alone never proves multiple selection,
and numeric values alone never prove NPS. Ranking and file-upload semantics
are not inferred. Keep unsupported fields unknown/private until mapped.

Section tabs use group labels from a saved profile or a bundled survey preset.
They do not reconstruct the original Customer Voice pages. The MAUI preset
has sections such as Experience, Editors, and AI and tools. The developer
survey preset marks uncertain parent prompts in its group labels. Unknown
exports without group labels keep the standard views; no page structure is
invented. Edit a field's group in Review profile to change section membership.

Hover a colored chart segment, or focus it with the keyboard, to see its
label, percentage, count, and valid-answer denominator. This includes ordered
satisfaction bars, grouped scales, NPS segments, and individual chart bars.
Press Escape to dismiss the tooltip.

The bundled MAUI profile retains the completion-date gate, recent-use
eligibility, seven-level Top-3-Box satisfaction method, source metadata, and
explicitly opt-in follow-up prompt. The earlier 921-row acceptance export had
868 eligible responses, NPS +5.3, and CSAT 78.0%. The **Response population** control
can include all submitted responses instead. Scores always use the selected
population and filters.

## Direct Customer Voice connection (experimental)

Use an approved Microsoft Entra public-client application, its tenant ID, and
the commercial-cloud Dataverse environment URL. The application must permit a
mobile/desktop localhost redirect. Do not enter a client secret. The viewer
does not create an app registration, grant consent, or change permissions.

1. Open **Direct Customer Voice connection** in the start view.
2. Enter the environment, tenant ID, and application ID.
3. Check the approval box and select **Sign in and list surveys**.
4. Complete Microsoft sign-in in the system browser. The MSAL browser flow
   does not expose a cancellation API to this viewer. Finish or cancel at the
   Microsoft sign-in page.
5. Select one survey, then confirm its question types and privacy mappings.
6. Select **Refresh data** for another complete read. **Cancel live read**
   cancels a data fetch. A failed or cancelled fetch leaves the old snapshot
   in place and shows an error.

The delegated scope is `<environment>/user_impersonation`. It is not a
read-only permission. The connector sends GET requests only. Use minimum
Dataverse reader privileges where your administrator permits. Tokens and the
MSAL cache stay in the extension process memory. A new process requires
sign-in again. Saved profiles contain connection identifiers, not credentials
or live response rows.

The connector checks required table metadata, reads every continuation page,
restricts answer joins to the selected survey, rejects off-environment links
before sending credentials, and uses bounded retries for throttling. Native
survey/question IDs are qualified by tenant and environment. Changed
definitions or identities require profile review. Only documented supported
choice representations are suggested; other representations remain unknown.

Reads are not a database transaction, and Customer Voice processing can lag.
Do not treat synthetic connector checks as evidence of live/export parity.
Other Microsoft clouds and cross-platform authentication have not been tested.

## Measurement and privacy

- NPS: `(count 9-10 - count 0-6) / valid integer 0-10 answers x 100`.
- Positive share: configured positive choices divided by valid nonblank
  answers after configured exclusions. No overall CSAT is inferred.
- Metric values are suppressed below five valid answers and marked
  directional below 30. Each metric includes its numerator, denominator,
  method, and source fingerprint.
- Multiple-selection counts deduplicate each choice within each response.
  Their percentages use respondents, not total selections.
- Only an explicitly approved `source` variable is exposed from personalized
  metadata. It is not the respondent's primary editor.
- Follow-up emails are isolated from aggregates and chat actions. A separate
  consent question must match its configured affirmative answer, unless the
  profile explicitly confirms that the address prompt itself is opt-in.
  Common address forms with apostrophes, plus tags, or quoted local parts are
  supported. Nonblank consented entries with unsupported formats are counted
  in an explicit warning. Review those entries in the private source export.
- Written answers use keyed, survey-scoped response references. Duplicate or
  blank response IDs disable private joins. Automated removal covers mapped
  private values, email addresses, common phone numbers, links, and selected
  self-identification patterns. It is not proof of anonymity. Review every
  quote before sharing it.
- Failed or schema-changing refreshes keep the last successful report. They
  do not replace it with a partial or success-shaped fallback.
- Closing a Canvas cancels its active data reads and Python reader processes.
  Microsoft browser sign-in itself remains subject to the MSAL limitation
  above. Authentication failures show the server's recovery message.
- A damaged saved profile or reading-state file is reported in the library.
  Other saved surveys remain available. The damaged file is not changed,
  moved, or deleted.
- Question, search, answer page, and scroll stay fixed during idle time.
  The refresh toolbar stays visible so manual refresh does not require
  scrolling away from an answer. Filters and private answers use the loaded
  snapshot without rereading the file. Reading settings survive new ports;
  search text is intentionally not restored after a page/process restart.

## Checks

```bash
python3 -m unittest discover -s tests -p '*_test.py'
node --test tests/server.test.mjs tests/dataverse.test.mjs
```

For the real .NET Developer Survey acceptance input, use an existing Playwright
installation and Chromium binary. This check does not download tools:

```bash
PLAYWRIGHT_MODULE=/full/path/playwright-core/index.mjs \
CHROMIUM_EXECUTABLE=/full/path/chromium \
CUSTOMER_VOICE_TEST_EXPORT=/private/path/developer-survey.xlsx \
node tests/browser-check.mjs
```

This real-data check expects 115 responses and 162 source columns. It imports
and confirms a profile in temporary storage, exercises charts, all-question
coverage, the full answer reader, consented contacts, manual refresh, ten
simulated idle minutes, and narrow layout. It removes its temporary profiles.
No real response fixtures or contact values belong in this repository.
For MAUI acceptance, use the same command with
`CUSTOMER_VOICE_TEST_PROFILE=maui` and the current MAUI export path. An independent
CSV calculation checks the current population, metric numerators and
denominators, and every source cohort. This check is not pinned to an old
response count. Both checks
also open a new server origin to test saved reading settings. They check
submitted versus eligible counts, and the MAUI check reconciles source scores.
No live source is used by these browser checks.

To exercise the connection controls with synthetic authentication and data:

```bash
export PLAYWRIGHT_MODULE=/full/path/playwright-core/index.mjs \
CHROMIUM_EXECUTABLE=/full/path/chromium

node tests/live-browser-check.mjs
node tests/usability-browser-check.mjs
```

This checks the approval control, survey selection, shared profile/charts,
and failure retention. It does not open Microsoft sign-in or contact a tenant.
Use `node tests/contact-browser-check.mjs` with the same Playwright environment
variables for synthetic address-redaction, consent, contact-display, and
unsupported-format warning checks.
The usability check exercises file selection and cancellation with a test picker,
quick view, later profile editing, section tabs, and hover/keyboard tooltips
with synthetic data.
The release includes a compiled AppKit file picker. Source runs use Swift
from the macOS command-line developer tools. No custom folder menu is used.

To check actual Copilot runtime registration and action routing without a model
call, use the SDK that ships with the installed App:

```bash
COPILOT_SDK_MODULE="/full/path/copilot-sdk/index.js" \
COPILOT_CLI_EXECUTABLE="/full/path/copilot" \
CUSTOMER_VOICE_TEST_EXPORT=/private/path/developer-survey.xlsx \
node tests/runtime-check.mjs
```

This uses isolated temporary Copilot storage and an unrelated working folder.
It checks native plugin discovery, Canvas open/close, input validation,
reserved-action rejection, actual workbook import, and full-answer access
through runtime actions. It does not replace a native App marketplace
install/update/restart check.

For an actual installed-version upgrade check, use a previous installed
version and a newer published version:

```bash
CUSTOMER_VOICE_PLUGIN_ROOT="$HOME/.copilot/installed-plugins/customer-voice-canvas/customer-voice-canvas" \
CUSTOMER_VOICE_TEST_UPDATE=yes CUSTOMER_VOICE_EXPECT_VERSION=0.2.1 \
node tests/update-check.mjs
```

This command updates the normal installed plugin. It uses synthetic data and
temporary profiles, checks that the saved profile and reading position are
unchanged, then reopens the report with the new package. It does not change
your real survey profiles.

## Build and publish

`.github/workflows/release.yml` checks source and builds a macOS arm64 package
on each pull request and push to `main`. It bundles the Python reader with
PyInstaller and includes locked Node dependencies. Package checks run with
Python and npm unavailable. Synthetic browser checks exercise the built
viewer. CI does not contain or upload real survey responses.

Only a successful `main` run can publish to `stable`. Publication appends a
commit without force-pushing. Pull requests have read-only repository access
and cannot publish. `release.json` records the source commit and version.
If a build or check fails, the existing stable package stays unchanged.

To reproduce a build on an Apple Silicon Mac:

```bash
python3 -m venv .build-venv
.build-venv/bin/python -m pip install -r requirements-build.txt
CUSTOMER_VOICE_BUILD_PYTHON="$PWD/.build-venv/bin/python" node scripts/build-release.mjs
node tests/package-check.mjs
```

The output is `dist/plugin`. Use a fresh checkout for each build. Update
`.github/plugin/plugin.json` for each release. The reader is ad-hoc signed by
PyInstaller, not Developer ID signed or notarized. Do not bypass macOS
security warnings. Intel Macs, Windows, and Linux currently need source setup.

## Remaining release gates

The direct connection needs an approved Entra public-client registration,
tenant ID, Dataverse environment URL, and reader access. No cloud registration,
permission grant, sign-in, or live response read has been performed. The
`user_impersonation` scope is not a read-only scope. The implemented connector
must still be checked in that environment and reconciled with a complete
matching export at a stated scope/cutoff.

The macOS release passed marketplace CLI installation and update, followed by
native Canvas discovery and opening in a new App chat. The installed package
also passed both real-export browser journeys and runtime actions. The
Customize install/update controls and a full App restart still need a user-run
check. Complete the live/export check before relying on the direct connector.
There is no public marketplace listing.
Do not replace the original MAUI Canvas until those gates pass.

The current App installation check could not run: the computer-use server
rejected access to GitHub Copilot with
`actions are blocked for this application by built-in safety policy`.
This is not an authentication failure. It does not justify another automation
path around that restriction. Native marketplace installation, update, and
App-restart checks need a permitted test path or a user-run check.
