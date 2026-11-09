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

Version 0.5.1 provides these packages. Marketplace entries are advertised only
after all required GitHub checks pass and the packages are published.

| System | Package name | Built package branch |
|---|---|---|
| macOS, Apple Silicon | `customer-voice-canvas` | `stable` |
| Windows x64 | `customer-voice-windows-x64` | `stable-windows-x64` |
| Windows 11 ARM64 | `customer-voice-windows-arm64` | `stable-windows-arm64` |
| Ubuntu or Fedora x64 | `customer-voice-linux-x64` | `stable-linux-x64` |
| Ubuntu or Fedora ARM64 | `customer-voice-linux-arm64` | `stable-linux-arm64` |

Intel Macs are not included. Install **one** package that matches the
architecture of the Copilot Node host. Installing multiple variants can
register duplicate Canvas types. Windows 11 ARM64 uses an x64 export reader
under Windows emulation. Its plugin host and system file dialog run through
the ARM64 Windows host. It is not a native ARM64 Python reader.
Version 0.4.1 corrects the reader architecture recorded in the Windows ARM64
package metadata and checks the executable header before publication.

The Linux compatibility checks target Ubuntu 24.04, Ubuntu 26.04, and Fedora 44
on each architecture. A graphical desktop, a session D-Bus service,
`xdg-desktop-portal`, and a desktop backend such as GNOME, GTK, or KDE are
required for file selection. Container checks exercise the reader and portal
protocol, not the visible desktop dialog. Package availability does not imply
that a Copilot App build with Canvas support is available for that system.
Confirm the host is available before distributing a Linux package.

The Copilot App
supplies Node. The plugin includes its survey reader and dependencies. You do
not need to clone the source, build the plugin, or run Python or npm setup
commands.

1. In the Copilot App, add `davidortinau/customer-voice-canvas` as a
   marketplace in **Customize**. Your GitHub account needs access to this
   private repository.
2. Select the package for your system from the table and install it.
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

For Windows or Linux, replace the package name before `@` with the matching
name from the table. The marketplace name after `@` stays
`customer-voice-canvas`.

The marketplace points to built package branches, not source on `main`.
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
For Linux source file selection, also install `dbus-next==0.2.3`.
Windows uses the system Windows PowerShell and Windows Forms dialog.
macOS source file selection requires Swift from the command-line tools.

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

1. Select **Open export**, then **Browse files**. The system file dialog
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

### Input checks and recovery

CSV files must use UTF-8 encoding and valid quoting. XLSX files must be valid
Excel workbooks. Select an existing sheet and a header row from 1 to 100.
The header must contain at least one column name, and at least one response
must follow it. Duplicate question names and individual blank column names
are allowed.

Imports have these limits: 64 MiB per file, 256 MiB of expanded workbook
content, 500,000 response rows, 2,048 columns, 2,000,000 source cells, and
1,000,000 characters per cell. Cell and row checks include blank source
cells and rows, plus missing fields padded to the header width. The reader
uses actual worksheet content because some Customer Voice exports have
incorrect declared worksheet dimensions.

An invalid import shows an error and does not replace the last loaded
report. Select a valid export to try again. A changed column structure
does not make a workbook invalid. If a saved profile no longer matches,
quick view uses a new proposal instead of the old mappings.

Emoji and non-English text are supported. Reader requests use UTF-8, and
reader replies use ASCII-safe JSON escapes. The viewer restores the original
characters. This avoids `UnicodeEncodeError` on systems with a non-UTF-8
console encoding; it does not remove or replace response text.

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

### Conditional questions and private contact fields

The reader keeps sparse and trailing source columns. A blank answer does not
show whether the survey displayed a conditional question. Counts use the
selected cohort; no branch eligibility is inferred from blanks.

All questions omits private fields and export metadata. Expand **private source
fields** there or in **Private follow-up** to see field names and counts, without
address values. **Method and column audit** lists every imported source column.
Email prompts stay private. A research permission prompt that asks "May we
contact you", does not request an address, and contains only observed Yes/No
answers can be suggested as a choice question even when it mentions an email
address. Empty or uncertain fields stay private until reviewed.

Sweepstakes entry is not research consent. The research directory uses one
confirmed email field and consent rule at a time. For a sweepstakes email,
select the separate research permission question and its affirmative answer.
For a different email prompt that itself states research consent, select that
private field and confirm the explicit opt-in rule. Neither path authorizes
the other, and no contact rule is enabled automatically. Use the private source
export for sweepstakes administration. This viewer does not combine contact
rules from separate branches.

Saved profiles keep their roles and consent rules. If a saved profile marks a
Yes/No permission question as private, **Review profile** shows the new suggested
role beside the saved role. Change that field to **choice**, enter its exact
Yes/No choices, check the research consent mapping, and save only after review.
An update does not change an existing profile automatically.

Hover a colored chart segment, or focus it with the keyboard, to see its
label, percentage, count, and valid-answer denominator. This includes ordered
satisfaction bars, grouped scales, NPS segments, and individual chart bars.
Press Escape to dismiss the tooltip.

### Edit, export, and share question charts

Select **Edit** on a question in a section or All questions. In Overview, use
the small pencil and download icons at the lower right of each question card.
Each icon has a tooltip and an accessible name.
Choose a presentation, then select **Save presentation**. Use **Review profile**
to save a profile first if you opened a quick view. Existing charts remain the
default until you choose a different presentation.

Choice, ordered-scale, and NPS questions support horizontal bars, columns,
dot plots, a data table, a 100% stacked bar, pie charts, and donut charts.
Multiple-choice, number, and date distributions support bars, columns, dots,
and tables. Pie and 100% stacked charts are not offered for multiple selections
or numerical and date distributions. No trend, correlation, or extra data
dimension is inferred. Written-answer questions support the answer reader or
a counts-only summary. Unknown fields support a summary until mapped.

Chart choices are stored in the saved profile by question ID. They do not
depend on response counts, file names, timestamps, or source hashes. They stay
in use after **Refresh data**, after reopening the viewer, and when the same
profile is used with a new file path. A change to the column structure requires
profile review. A change to a question type resets chart choices that no longer
match.

Select **Export graphic** on any question, then choose **Export SVG** or
**Export PNG**. SVG is scalable. PNG is 2,000 pixels wide. The graphic uses the
current presentation and includes the question label, counts, denominator,
scoring method when available, population, and active filters. It does not
include written answers or contacts. Check question labels and choice labels
before sharing. Large questions that exceed the PNG size limit must use SVG.
Wide chart graphics scroll within their panel on small screens.

Open **Share presentation settings** to export a JSON file. Each recipient
opens their own report data, saves a profile, and selects **Import settings**.
The viewer checks question identities, original headers, and question types
before offering **Apply settings**. Live reports also require matching source
question IDs. A mismatched or invalid file does not change the profile.
The settings can be used with new response data and a different local file path.

Shared settings contain chart choices, question identities, viewer themes,
chart palettes, and custom theme definitions. They do
not contain response rows, contacts, local paths, access tokens, private keys,
filters, or search terms. They do not replace mappings, scoring, consent,
section groups, or reading positions. Those remain in each local profile.

### Viewer themes and chart colors

Select **Appearance** to choose viewer colors and chart colors separately.
Viewer presets include Studio, Sea glass, Iris, Midnight, Graphite, and
**High contrast**. **Follow system** uses measured light and dark color sets
and follows the system preference. Essential colors do not inherit untested
host color overrides. Host fonts stay in use.
Chart palettes include Original, Coast, Orchid, Woodland, and Clear contrast.
Changing viewer colors does not change chart marks. Changing the chart palette
does not change viewer colors.

Open **Create a custom viewer theme** to name a theme and set its background,
text, muted text, accent, and border colors. Open **Create a custom chart palette**
to name a palette, set six ordered chart colors, and set three NPS group colors.
The chart scale interpolates between the six colors. Each report keeps one custom
viewer theme and one custom chart palette, even when a preset is selected.
The preview shows the category scale and the separate NPS group colors.
NPS **Original view** uses the three group colors. Alternative NPS chart types
use the category scale for individual scores.
Charts and graphics use solid colors, without hatch or pattern overlays.
The preview changes only inside the dialog. Select **Save appearance** to apply
and save changes, or **Cancel** to keep the current settings.
In quick view, **Apply appearance** changes colors without saving a profile.
The colors stay for the current view and manual refresh, not a new viewer session.
Use **Save with profile** to apply the colors and open the profile review.
Confirm the mappings and select **Save profile and open report** to keep the
colors after reopening. This does not bypass the privacy and consent checks.

Custom viewer text must have at least 4.5:1 contrast on report surfaces.
New custom chart edits require at least 3:1 contrast against white exports.
Errors identify the color to change. **Use readable custom colors** replaces
draft colors with measured defaults; **Cancel** still leaves saved settings
unchanged. Color fields have both a native picker and a named hex input.
SVG and PNG graphics use the selected chart colors with a white background and
dark text, independent of the viewer theme.

Themes stay with the saved profile after refresh, a restart, or new response data.
**Export settings** includes both selections and custom definitions in version 2
settings files. Import checks the definitions before it changes the profile.
Older version 1 settings files still work and keep the current theme colors.
Version 2 files require a viewer with theme support.

### Accessibility of themes and charts

The implementation targets WCAG 2.2 AA requirements for
[text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html),
[non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html),
[use of color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html),
[hover and focus content](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html),
[focus visibility](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html),
[reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), and
[target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
This is not a formal conformance claim.

Controls use measured text-colored boundaries and focus rings. Selected themes
also show **Selected**, rather than a color change alone. Overview icons keep
their 28-by-28 CSS-pixel targets and accessible names. The snapshot toolbar no
longer stays over content when you scroll, so it cannot cover keyboard focus.
Chart tooltips can be hovered and dismissed with Escape.

All viewer/chart combinations use contrasting chart outlines. Pie and stacked
charts have numbered segments and numbered labels in graphics.
Original grouped bars use matching group numbers. **View data**
provides a named HTML table for every distribution, with row and column headers.
Position, numbers, labels, and the complete
data table remain available when colors are hard to distinguish.
Very small pie slices can omit an overlaid number to avoid overlap; the
clockwise row-order note and numbered entries still identify the data.

High contrast is an extra viewer choice, not a substitute for readable defaults.
Forced-colors mode uses system control colors and opens distribution data tables
automatically. Older saved palettes and version 2 settings remain loadable,
including pale chart fills; outlines, labels, and tables protect their data.
Saving a new custom-color edit requires the current contrast checks.

Checks cover all shipped theme/palette combinations, UI states, color-vision
simulations, keyboard controls, and a 320-CSS-pixel viewport, equivalent to
400% zoom from 1280 pixels. Simulations and accessibility-tree checks do not
replace testing by people with color-vision deficiencies, human screen-reader
testing, native Windows high-contrast testing, or a full accessibility review.
Add suitable alt text when placing exported graphics in a document or slide.
PNG does not supply a screen-reader data table to the destination application.

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
Customer Voice quoted choice lists, including lists without JSON array
brackets, are supported. Likert rows inherit their parent question's scale.
Multiple selections use the same semicolon-separated form as exports, and
surrounding answer whitespace is removed to match the export reader. Answers
outside the declared choices, such as written **Other** answers, remain
review-needed. They are not added to public chart labels automatically.

Reads are not a database transaction, and Customer Voice processing can lag.
Do not treat synthetic connector checks as evidence of live/export parity.
Other Microsoft clouds and cross-platform authentication have not been tested.

### Live-data proof and remaining sign-in limit

A read-only proof against an authorized MAUI survey matched all 945 records
in the saved export by Customer Voice source response ID. All 31 survey
answer columns matched after the shared export normalization, including the
optional follow-up field. Scored metrics and submitted/eligible populations
also matched at that same response scope. The live read had 948 records;
the three additional records were not included in the export comparison.

The browser proof exercised real survey selection, report generation,
explicit refresh, and retention of the last report after a real HTTP 401.
It used an existing corporate Azure CLI session through a test-only sign-in
adapter. No token or response rows were saved. This does **not** prove the
shipped interactive MSAL sign-in flow or establish an approved application
registration for other users. That sign-in test remains required before
calling the direct connection ready for distribution.

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
node --test tests/server.test.mjs tests/dataverse.test.mjs tests/presentation.test.mjs tests/themes.test.mjs tests/accessibility.test.mjs
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
node tests/presentation-browser-check.mjs
node tests/themes-browser-check.mjs
node tests/accessibility-browser-check.mjs
```

This checks the approval control, survey selection, shared profile/charts,
and failure retention. It does not open Microsoft sign-in or contact a tenant.
Use `node tests/contact-browser-check.mjs` with the same Playwright environment
variables for synthetic address-redaction, consent, contact-display, and
unsupported-format warning checks.
The usability check exercises file selection and cancellation with a test picker,
quick view, later profile editing, section tabs, and hover/keyboard tooltips
with synthetic data.
The presentation check edits charts, refreshes response data, reopens a saved
profile, checks SVG and PNG contents, and imports shared settings into a second
profile with different response data. Set `CUSTOMER_VOICE_EVIDENCE` to a scratch
folder to save screenshots, a question graphic, and an example settings file.
The theme check changes viewer and chart colors independently, saves custom
colors, refreshes and reopens the report, exports themed graphics, imports
settings into another profile, and checks the compact overview controls.
The macOS release includes a compiled AppKit file picker. Windows uses a
Windows Forms file dialog. Linux includes a desktop-portal client. No custom
folder menu is used. Linux protocol checks use a private D-Bus session and a
simulated portal to check selection, cancellation, and invalid URI rejection.
They do not prove that a desktop backend displays the dialog.

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

`.github/workflows/release.yml` checks source and builds all five packages
on each pull request and push to `main`. It bundles the Python reader with
PyInstaller and includes locked Node dependencies. Package checks run with
Python and npm unavailable. Synthetic browser checks exercise the built
viewer on macOS, Windows x64, and both Linux architectures. Windows ARM64 runs
source and package checks but skips the Chromium browser checks because
Playwright does not supply a native Windows ARM64 Chromium build. CI does not
contain or upload real survey responses.

Both Linux packages must also pass CSV and XLSX import, scoring, manual
refresh, and portal-protocol checks in Ubuntu 24.04, Ubuntu 26.04, and Fedora 44
containers. The same package is used across the three distributions.

Only a successful `main` run can publish to the five package branches.
Publication appends a
commit without force-pushing. Pull requests have read-only repository access
and cannot publish. `release.json` records the source commit and version.
If a build or check fails, publication does not start. Publication validates
all downloaded package identities before it updates any branch. Branch
updates are separate Git pushes, not one transaction. If a push fails, some
channels can be newer than others; rerun the workflow after correcting the
failure. The marketplace advertises new channels only after all branch pushes
succeed. Its first platform-catalog update is a separate bot commit on `main`.
Downloadable `.tar.gz` packages are retained as workflow artifacts for 14 days;
the built branches are the persistent installation source.

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
security warnings. Windows packages are not code signed. Do not bypass system
security warnings on any platform.

### Custom icon

The viewer uses the selected `b-sentiment-ring` design in its header and as its
browser icon starting with version 0.4.2. The SVG master, 512 by 512 PNG, and 32 by 32 PNG are packaged
under `extensions/customer-voice/assets/`. The current Canvas SDK does not
expose a custom icon field for App search or the Canvas tab.

## Remaining release gates

All five 0.4.0 packages passed their hosted build and package checks. Both
Linux architectures passed compatibility checks on all three distributions.
The [first successful multi-platform release run](https://github.com/davidortinau/customer-voice-canvas/actions/runs/41096167398)
records those results. macOS, Windows x64, and both Linux architectures also
passed the packaged browser checks. Windows and Linux still need a user-run native
file-dialog check in a desktop session and an installation/open check in a
compatible Canvas host. These checks are not replaced by container tests.

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
