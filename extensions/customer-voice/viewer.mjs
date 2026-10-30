const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const token = location.hash.slice(1);
let report, proposal, surveyId, selected, tab = "overview", answers, contacts;
let answerSearch = "", questionSearch = "", answerPage = 0, filters = {};
let restorePosition;
const pageSize = 20;

async function api(name, payload = {}) {
    const response = await fetch(`/api/${name}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload), keepalive: name === "view",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Cannot complete the local survey request.");
    return data;
}

async function work(message, action) {
    const position = { scroll: window.scrollY, listScroll: $("#question-list")?.scrollTop || 0 };
    $("#error").hidden = true;
    $("#status").textContent = message;
    document.querySelectorAll("button").forEach(button => { button.disabled = true; });
    $("#cancel-read").disabled = false;
    try { await action(position); $("#status").textContent = ""; }
    catch (error) {
        $("#error").textContent = `${error.message}${report ? " The last loaded snapshot is still shown." : ""}`;
        $("#error").hidden = false;
        $("#status").textContent = "The operation failed. No partial snapshot was loaded.";
    } finally {
        $("#cancel-read").hidden = true;
        document.querySelectorAll("button").forEach(button => {
            button.disabled = button.dataset.disabled === "true";
        });
        if (restorePosition) {
            if ($("#question-list")) $("#question-list").scrollTop = restorePosition.listScroll;
            window.scrollTo(0, restorePosition.scroll);
            restorePosition = null;
            saveView();
        }
    }
}

function showSetup() {
    $("#start").hidden = false;
    $("#setup").hidden = false;
    $("#mapping").hidden = true;
    $("#path").focus();
}

function options(values, value = "") {
    return values.map(item => {
        const [id, label] = Array.isArray(item) ? item : [item, item];
        return `<option value="${escape(id)}"${id === value ? " selected" : ""}>${escape(label)}</option>`;
    }).join("");
}

function saveView() {
    if (!surveyId || report?.preview) return;
    api("view", { selected, tab, answerSearch, questionSearch, answerPage,
        scroll: Math.round(window.scrollY), listScroll: Math.round($("#question-list")?.scrollTop || 0) })
        .catch(error => {
            $("#error").hidden = false;
            $("#error").textContent = `Cannot save reading state: ${error.message}`;
        });
}

function renderMapping() {
    const profile = proposal.previous?.headers.join("\0") === proposal.profile.headers.join("\0")
        && proposal.previous?.sourceDefinition === proposal.profile.sourceDefinition
        && proposal.previous?.sourceIdentity === proposal.profile.sourceIdentity
        ? structuredClone(proposal.previous) : proposal.profile;
    proposal.edit = profile;
    const fields = profile.fields;
    const fieldOptions = [["", "None"], ...fields.map(f => [f.id, `${f.id}: ${f.label}`])];
    $("#mapping").innerHTML = `
      <div class="overline">02 / CONFIRM THE MEANING</div>
      <h2>One profile. Every source column.</h2>
      <p class="muted">${proposal.source.rows} responses / ${proposal.source.columns} columns.
      Suggested types are not confirmed question definitions.</p>
      <div class="notice">Check each question type. Set scale order and positive choices only when the survey supports them.
      Original pages and branching are not available in a flat export. Section labels come from the saved profile or a bundled suggestion.
      You can change them below.</div>
      <button id="quick-view" class="primary">View report with defaults</button>
      <label>Survey title<input id="profile-title" value="${escape(profile.title)}"></label>
      <div class="profile-controls">
        <label>Submission completion date (optional)<select id="submission-field">${options(fieldOptions, profile.submission?.field)}</select></label>
        <label>Population: include only this question's value<select id="eligible-field">${options(fieldOptions, profile.eligibility?.field)}</select></label>
        <label>Eligible answer<input id="eligible-value" value="${escape(profile.eligibility?.value || "")}"></label>
        <label><input id="metadata-source" type="checkbox"${profile.metadataSource ? " checked" : ""}>Enable the source metadata dimension only</label>
        <label>Private follow-up email field<select id="contact-field">${options(fieldOptions, profile.followup?.contact)}</select></label>
        <label>Separate consent question<select id="consent-field">${options(fieldOptions, profile.followup?.consent)}</select></label>
        <label>Affirmative consent answer<input id="consent-value" value="${escape(profile.followup?.value || "Yes")}"></label>
        <label><input id="address-consent" type="checkbox"${profile.followup?.addressIsConsent ? " checked" : ""}>The email prompt itself explicitly requests opt-in follow-up</label>
      </div>
      <div class="mapping-list">${fields.map(f => `
        <details class="map-row" data-field="${f.id}">
          <summary>${f.id} / ${escape(f.label)} <span class="fine">[${escape(f.kind)}] / ${f.answered ?? "mapped"} answered</span></summary>
          <p class="fine">${escape(f.reason || "Saved mapping. Check against the current export.")}</p>
          <div class="map-fields">
            <label>Question type<select data-key="kind">${options(
                ["unknown", "choice", "multiple", "ordered", "nps", "number", "date", "text", "private", "system", "metadata"], f.kind)}</select></label>
            <label>Display label<input data-key="label" value="${escape(f.label)}"></label>
            <label>Matrix or section group<input data-key="group" value="${escape(f.group)}"></label>
            <label>Choices in display order (one per line)<textarea data-key="choices">${escape(f.choices.join("\n"))}</textarea></label>
            <label>Positive choices (one per line, optional)<textarea data-key="positive">${escape(f.positive.join("\n"))}</textarea></label>
            <label>Excluded choices (one per line)<textarea data-key="exclude">${escape(f.exclude.join("\n"))}</textarea></label>
            <label><input data-key="filter" type="checkbox"${f.filter ? " checked" : ""}>Allow as a cohort filter</label>
          </div>
        </details>`).join("")}</div>
      <div class="notice">A saved profile contains the file reference, question mappings, and approved choices.
      It does not contain response rows or contact values. For a session attachment, move the file to your own private durable folder before long-term use.</div>
      <p><label><input id="confirm-mappings" type="checkbox">I checked the field roles, scoring, privacy, and consent mappings.</label></p>
      <div class="actions"><button id="confirm-profile" class="primary">Save profile and open report</button><button id="cancel-profile">Cancel</button></div>`;
    $("#mapping").hidden = false;
    $("#setup").hidden = true;
    $("#mapping").scrollIntoView();
    $("#quick-view").onclick = () => work("Opening report with defaults...", previewReport);
    $("#confirm-profile").onclick = () => work("Checking the confirmed profile...", async () => {
        if (!$("#confirm-mappings").checked) throw new Error("Check the profile confirmation box before saving.");
        for (const row of document.querySelectorAll(".map-row")) {
            const field = fields.find(f => f.id === row.dataset.field);
            for (const input of row.querySelectorAll("[data-key]")) {
                const key = input.dataset.key;
                field[key] = input.type === "checkbox" ? input.checked :
                    input.tagName === "TEXTAREA" ? input.value.split("\n").map(x => x.trim()).filter(Boolean) : input.value;
            }
            if (!["choice", "ordered", "multiple"].includes(field.kind)) field.choices = [];
        }
        profile.title = $("#profile-title").value.trim() || "Survey";
        profile.eligibility = $("#eligible-field").value
            ? { field: $("#eligible-field").value, value: $("#eligible-value").value.trim() } : null;
        profile.metadataSource = $("#metadata-source").checked;
        profile.submission = $("#submission-field").value ? { field: $("#submission-field").value, kind: "date" } : null;
        profile.followup = $("#contact-field").value ? {
            contact: $("#contact-field").value, consent: $("#consent-field").value,
            value: $("#consent-value").value.trim(), addressIsConsent: $("#address-consent").checked,
        } : null;
        const result = await api("confirm", { ticket: proposal.ticket, profile });
        const config = await api("config");
        $("#reuse-profile").innerHTML = options([["", "New survey"], ...config.surveys.map(s => [s.id, s.title])], result.surveyId);
        renderLibrary(config.surveys, config.warnings);
        surveyId = result.surveyId;
        filters = {}; answers = null; contacts = null;
        $("#mapping").hidden = true;
        await acceptReport(result);
    });
    $("#cancel-profile").onclick = () => { $("#mapping").hidden = true; $("#setup").hidden = Boolean(report); };
}

async function previewReport() {
    const result = await api("preview", { ticket: proposal.ticket });
    tab = "overview"; selected = undefined; answerPage = 0;
    answerSearch = ""; questionSearch = ""; answers = null; contacts = null;
    $("#mapping").hidden = true;
    await acceptReport(result);
}

function tip(label, count, percent, denominator, extraClass = "") {
    const text = `${label}: ${percent}% / ${count} of ${denominator} valid answers`;
    return `class="chart-segment ${extraClass}" tabindex="0" data-tooltip="${escape(text)}" aria-label="${escape(text)}" aria-describedby="chart-tooltip"`;
}

function metricCard(q) {
    const m = q.metric;
    return `<article class="metric"><p class="fine">${escape(q.label)}</p>
      <div class="metric-value">${m.value === null ? "Suppressed" : escape(m.value) + (m.label === "NPS" ? "" : "%")}</div>
      <h3>${escape(m.label)}</h3><p class="fine">${escape(m.status)} / n=${m.denominator}
      / numerator ${m.numerator}</p><p class="fine">${escape(m.method)}</p></article>`;
}

function bars(q) {
    if (q.kind === "nps") {
        const max = Math.max(1, ...q.distribution.map(x => x.count));
        const colors = ["var(--bad)", "var(--muted)", "var(--good)"];
        return `<div class="histogram" role="img" aria-label="Recommendation score counts from zero through ten">${q.distribution.map(x => `
          <div class="hist-col"><span>${x.count}</span><div ${tip(`Score ${x.label}`, x.count, x.percent, q.valid, "hist-bar")} style="height:${Math.max(1, x.count / max * 145)}px;background:${colors[+x.label <= 6 ? 0 : +x.label <= 8 ? 1 : 2]}"></div>${x.label}</div>`).join("")}</div>
          ${q.metric ? `<div class="balance">${["detractors", "passives", "promoters"].map((key, i) => `
          <div ${tip(["Detractors (0-6)", "Passives (7-8)", "Promoters (9-10)"][i], q.metric[key],
              q.valid ? Math.round(q.metric[key] / q.valid * 1000) / 10 : 0, q.valid)}
            style="width:${q.valid ? q.metric[key] / q.valid * 100 : 0}%;background:${colors[i]}"></div>`).join("")}</div>
          <div class="legend">${["Detractors (0-6)", "Passives (7-8)", "Promoters (9-10)"].map((label, i) =>
              `<span><i class="swatch" style="background:${colors[i]}"></i>${label}</span>`).join("")}</div>` : ""}`;
    }
    if (!q.distribution) return `<p class="notice">${q.kind === "text"
        ? "Read the written answers in All questions." : "This field has no confirmed chart mapping."}</p>`;
    const stacked = q.kind === "ordered" ? `<div class="balance">${q.distribution.map((d, i) =>
        `<div ${tip(d.label, d.count, d.percent, q.valid)} style="width:${d.percent}%;background:${scaleColor(i, q.distribution.length)}"></div>`).join("")}</div>` : "";
    return `${stacked}<div class="horizontal">${q.distribution.map(d => `
      <div class="bar-row"><div class="bar-label">${escape(d.label)}</div>
        <div class="bar-track"><div ${tip(d.label, d.count, d.percent, q.valid)} style="width:${Math.min(100, d.percent)}%;height:100%;background:var(--accent);border-radius:3px"></div></div>
        <div class="bar-value">${d.count} / ${d.percent}%</div></div>`).join("")}</div>
      <p class="fine">Denominator: ${q.valid} valid nonblank answers. ${q.multiSelect
        ? "Multiple selections: each respondent counts once per choice. Percentages can sum above 100%." : ""}
        ${escape(q.units || "")}</p>`;
}

function scaleColor(index, length) {
    return `hsl(${205 - index * 120 / Math.max(1, length - 1)} 32% ${48 + index * 4}%)`;
}

function matrix(group, questions) {
    const domain = questions[0].distribution?.map(d => d.label);
    if (!domain || !questions.every(q => q.kind === "ordered"
        && JSON.stringify(q.distribution.map(d => d.label)) === JSON.stringify(domain))) return "";
    const colors = domain.map((_, i) => scaleColor(i, domain.length));
    return `<section class="panel"><h3>${escape(group)}</h3><div class="legend">${domain.map((v, i) =>
        `<span><i class="swatch" style="background:${colors[i]}"></i>${escape(v)}</span>`).join("")}</div>
      ${questions.map(q => `<div class="bar-row"><span>${escape(q.label)}</span><div class="balance">
      ${q.distribution.map(d => `<div ${tip(d.label, d.count, d.percent, q.valid)} style="width:${d.percent}%;background:${colors[domain.indexOf(d.label)]}"></div>`).join("")}
      </div><span class="fine">n=${q.valid}</span></div>`).join("")}</section>`;
}

function surveyQuestions() {
    return report.questions.filter(q => !["system", "metadata", "private"].includes(q.kind));
}

function renderSection(group) {
    const questions = surveyQuestions().filter(q => q.group === group);
    return `<p class="overline">SURVEY SECTION</p><h2>${escape(group)}</h2>
      <p class="fine">${questions.length} questions. Sections use profile group labels, not recovered survey pages.</p>
      ${matrix(group, questions)}
      <div class="grid">${questions.map(q => `<article class="panel"><h3>${escape(q.label)}</h3>
        ${q.metric ? metricCard(q) : ""}
        ${q.kind === "text" ? `<p class="fine">${q.answered} written answers</p><button data-read-question="${q.id}">Read all answers</button>` : bars(q)}</article>`).join("")}</div>`;
}

function renderOverview() {
    const questions = report.questions.filter(q => !["system", "metadata", "private"].includes(q.kind));
    const metrics = questions.filter(q => q.metric);
    const groups = [...new Set(questions.map(q => q.group).filter(Boolean))];
    return `<p class="overline">AT A GLANCE</p><h2>The shape of this survey.</h2>
      <p class="muted">${report.scope.selected} selected / ${report.scope.eligible} eligible / ${report.scope.submitted} submitted / ${report.scope.exported} source rows.
      ${escape(report.scope.population)}</p>
      <div class="metrics"><article class="metric"><p class="fine">Question coverage</p>
      <div class="metric-value">${questions.length}</div><h3>Survey questions</h3>
      <p class="fine">${report.questions.length} source columns accounted for. ${questions.filter(q => q.kind === "text").length} written-answer fields.</p></article>
      ${metrics.map(metricCard).join("")}</div>
      ${groups.map(group => matrix(group, questions.filter(q => q.group === group))).join("")}
      <div class="grid">${questions.filter(q => q.distribution).slice(0, 8).map(q => `
      <article class="panel"><h3>${escape(q.label)}</h3>${bars(q)}</article>`).join("")}</div>
      ${renderSourceGroups()}<p class="notice">Every question is available in All questions. This overview shows the first eight charted questions.
      No overall satisfaction score is inferred.</p>`;
}

function renderSourceGroups() {
    if (!report.sourceGroups.length) return "";
    const metrics = report.sourceGroups[0].metrics;
    return `<section class="panel"><h2>By source metadata</h2><p class="fine">Same population and cohort filters.
      Source is not the respondent's editor.</p><div class="table-wrap"><table><thead><tr><th>Source</th><th>Responses</th>
      ${metrics.map(m => `<th>${escape(m.question)} / ${escape(m.label)}</th>`).join("")}</tr></thead><tbody>
      ${report.sourceGroups.map(g => `<tr><td>${escape(g.source)}</td><td>${g.n}</td>${g.metrics.map(m =>
          `<td>${m.value === null ? "Suppressed" : escape(m.value)} / n=${m.denominator}<br><span class="fine">${escape(m.status)} / numerator ${m.numerator}</span></td>`).join("")}</tr>`).join("")}
      </tbody></table></div></section>`;
}

function renderQuestionList() {
    const term = questionSearch.toLowerCase();
    $("#question-list").innerHTML = report.questions
        .filter(q => !["system", "metadata", "private"].includes(q.kind))
        .filter(q => `${q.id} ${q.label} ${q.group}`.toLowerCase().includes(term))
        .map(q => `<button class="question-link" data-question="${q.id}"${q.id === selected ? ' aria-current="true"' : ""}>
          <span class="fine">${q.id} / ${escape(q.kind)} / ${q.answered} answered</span><br>${escape(q.label)}</button>`).join("");
    $("#question-list").querySelectorAll("button").forEach(button => {
        button.onclick = () => work("Loading question...", async () => {
            selected = button.dataset.question;
            answerPage = 0; answerSearch = ""; answers = null;
            renderQuestionList();
            await renderDetail();
            saveView();
        });
    });
}

async function renderDetail() {
    const q = report.questions.find(q => q.id === selected);
    if (!q || !$("#question-detail")) return;
    $("#question-detail").innerHTML = `
      <p class="overline">${q.id} / ${escape(q.kind)}${q.group ? " / " + escape(q.group) : ""}</p>
      <h2>${escape(q.label)}</h2>
      <details><summary>Original source wording</summary><p class="fine">${escape(q.header)}</p></details>
      <div class="stats"><div><strong>${q.answered}</strong>Answered</div><div><strong>${q.blank}</strong>Blank</div>
      <div><strong>${q.valid}</strong>Valid nonblank</div><div><strong>${q.excluded}</strong>Excluded</div></div>
      ${q.metric ? metricCard(q) : ""}
      ${q.kind === "text" ? `<div class="notice">${escape(report.warning)}</div>
        <div class="answer-tools"><label>Search all written answers<input id="answer-search" value="${escape(answerSearch)}"></label>
        <span class="fine" id="answer-count"></span></div><div id="answer-list"></div><div id="answer-pagination" class="pagination"></div>`
        : bars(q)}`;
    if (q.kind === "text") {
        if (!answers || answers.question !== q.id) answers = await api("answers", {
            question: q.id, sha256: report.source.sha256,
        });
        $("#answer-search").oninput = event => {
            answerSearch = event.target.value; answerPage = 0; renderAnswers(); saveView();
        };
        renderAnswers();
    }
}

function renderAnswers() {
    const matched = answers.answers.filter(a => a.text.toLowerCase().includes(answerSearch.toLowerCase()));
    answerPage = Math.min(answerPage, Math.max(0, Math.ceil(matched.length / pageSize) - 1));
    $("#answer-count").textContent = `${matched.length} matches / ${answers.total} written answers`;
    $("#answer-list").innerHTML = matched.slice(answerPage * pageSize, (answerPage + 1) * pageSize)
        .map(a => `<article class="answer-card" data-answer-id="${a.id}"><code>Response ${a.id}</code><p>${escape(a.text)}</p></article>`).join("")
        || `<p class="notice">No matching written answers.</p>`;
    $("#answer-pagination").innerHTML = `
      <button id="previous" data-disabled="${answerPage === 0}"${answerPage === 0 ? " disabled" : ""}>Previous answers</button>
      <span>Page ${answerPage + 1} of ${Math.max(1, Math.ceil(matched.length / pageSize))}</span>
      <button id="next" data-disabled="${(answerPage + 1) * pageSize >= matched.length}"${(answerPage + 1) * pageSize >= matched.length ? " disabled" : ""}>Next answers</button>`;
    for (const [id, step] of [["previous", -1], ["next", 1]]) $(`#${id}`).onclick = () => {
        answerPage += step; renderAnswers(); saveView();
    };
}

async function renderContent() {
    $("#chart-tooltip").hidden = true;
    const groups = [...new Set(surveyQuestions().map(q => q.group).filter(Boolean))];
    if (tab.startsWith("group:") && !groups.includes(tab.slice(6))) tab = "overview";
    $("#section-tabs").hidden = !groups.length;
    $("#section-tabs").innerHTML = groups.map(group =>
        `<button data-tab="${escape(`group:${group}`)}">${escape(group)}</button>`).join("");
    document.querySelectorAll("[data-tab]").forEach(button => {
        if (button.dataset.tab === tab) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
        button.onclick = () => work("Opening survey view...", async () => {
            tab = button.dataset.tab; await renderContent(); saveView();
        });
    });
    if (tab === "overview") $("#content").innerHTML = renderOverview();
    if (tab.startsWith("group:")) {
        $("#content").innerHTML = renderSection(tab.slice(6));
        $("#content").querySelectorAll("[data-read-question]").forEach(button => {
            button.onclick = () => work("Loading written answers...", async () => {
                selected = button.dataset.readQuestion; tab = "questions";
                answers = null; answerPage = 0; answerSearch = ""; questionSearch = "";
                await renderContent(); saveView();
            });
        });
    }
    if (tab === "questions") {
        const questions = report.questions.filter(q => !["system", "metadata", "private"].includes(q.kind));
        if (!questions.some(q => q.id === selected)) selected = questions[0]?.id;
        $("#content").innerHTML = `<div class="explorer"><aside class="question-nav">
          <label>Find a question<input id="question-search" value="${escape(questionSearch)}"></label>
          <p class="fine">${questions.length} questions / ${report.questions.length} source columns</p><div id="question-list"></div>
          </aside><section id="question-detail" class="detail"></section></div>`;
        renderQuestionList();
        $("#question-search").oninput = event => {
            questionSearch = event.target.value; renderQuestionList(); saveView();
        };
        await renderDetail();
    }
    if (tab === "contacts") {
        $("#content").innerHTML = `<h2>Private follow-up directory</h2><p class="muted">Only addresses allowed by the confirmed consent mapping.
          No metadata email fallback. No automatic outreach.</p>
          <div class="notice">Contact data is private. It is not included in the chart or chat analysis result.</div>
          ${report.contactEnabled ? '<button id="load-contacts">Show consented contacts</button><div class="contacts" id="contacts"></div>'
            : '<p class="notice">Follow-up is not mapped. Use Review profile to select a private email field and its consent rule.</p>'}`;
        if ($("#load-contacts")) $("#load-contacts").onclick = () => work("Loading private contacts...", async () => {
            contacts = await api("contacts", { sha256: report.source.sha256 });
            $("#contacts").innerHTML = `<p>${contacts.contacts.length} consented contacts in this cohort</p>` +
                (contacts.unsupportedAddressCount ? `<p class="notice">${contacts.unsupportedAddressCount} consented entries have an unsupported address format.
                Review those entries in the private source export. They are not shown here.</p>` : "") +
                contacts.contacts.map(c => `<p><code>${c.id}</code> / <a href="mailto:${escape(encodeURIComponent(c.email))}">${escape(c.email)}</a></p>`).join("");
        });
    }
    if (tab === "method") $("#content").innerHTML = `
      <h2>A clear measurement contract.</h2>
      <div class="notice">${escape(report.scope.population)} Blanks are not proof that a question was skipped.
      Scores use each question's valid nonblank denominator. Below five: score suppressed. Below 30: directional.
      ${report.preview ? "Quick view: question types, groups, and scoring are suggestions, not confirmed survey definitions." : "Profile settings are saved."}
      Positive-share choices and exclusions must be confirmed. NPS uses the standard 0-10 definition.</div>
      <p class="fine">SHA-256: ${escape(report.source.sha256)}. Header row: ${report.source.header}.
      Source sheet: ${escape(report.source.sheet)}. ${report.source.rows} rows, ${report.source.columns} columns.
      ${escape(report.source.warning || "")}
      Data reads occur only on explicit import, open, or refresh. Filters and private answers use the loaded in-memory snapshot. No polling or source-file watcher is used.</p>
      <p class="fine">${escape(report.warning)}</p>
      <div class="table-wrap"><table class="audit"><thead><tr><th>Column</th><th>Original header</th><th>${report.preview ? "Suggested role" : "Confirmed role"}</th><th>Answered</th><th>Blank</th></tr></thead>
      <tbody>${report.questions.map(q => `<tr><td>${q.id}</td><td>${escape(q.header || "[blank header]")}</td><td>${escape(q.kind)}</td><td>${q.answered}</td><td>${q.blank}</td></tr>`).join("")}</tbody></table></div>`;
}

async function acceptReport(result, persist = true) {
    report = result;
    filters = result.scope.filters;
    surveyId = result.surveyId;
    $("#start").hidden = true;
    $("#setup").hidden = true;
    $("#dashboard").hidden = false;
    $("#preview-notice").hidden = !result.preview;
    $("#title").textContent = result.title;
    $("#subtitle").textContent = result.scope.population;
    $("#source-name").textContent = result.source.name;
    $("#fingerprint").textContent = result.source.sha256;
    $("#counts").textContent = `${result.scope.selected} selected / ${result.scope.submitted} submitted / ${result.scope.exported} source rows`;
    $("#population").value = result.scope.populationKey;
    $("#loaded-time").textContent = `Loaded ${new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium", timeStyle: "short", timeZone: "America/Chicago",
    }).format(new Date())} CT`;
    $("#filters").innerHTML = result.filterOptions.map(f => `
      <label>${escape(f.label)}<select data-filter="${escape(f.id)}">${options([["", "All"], ...f.values], filters[f.id])}</select></label>`).join("");
    $("#filters").querySelectorAll("select").forEach(select => {
        select.onchange = () => work("Applying cohort filters...", async () => {
            const next = Object.fromEntries([...$("#filters").querySelectorAll("select")]
                .filter(s => s.value).map(s => [s.dataset.filter, s.value]));
            const filtered = await api("filter", { filters: next });
            filters = next; answers = null; contacts = null;
            await acceptReport(filtered); saveView();
        });
    });
    await renderContent();
    if (persist) saveView();
}

$("#start-import").onclick = $("#open-export").onclick = showSetup;
$("#import-form").onsubmit = event => {
    event.preventDefault();
    const quick = event.submitter?.value === "preview";
    work("Inspecting source columns...", async () => {
        proposal = await api("inspect", {
            path: $("#path").value.trim(), sheet: $("#sheet").value.trim() || 0,
            header: Number($("#header-row").value), id: $("#reuse-profile").value || undefined,
        });
        if (quick) await previewReport();
        else renderMapping();
    });
};
$("#review-profile").onclick = () => work("Opening profile settings...", async () => {
    proposal = await api("review"); renderMapping();
});
$("#refresh").onclick = () => work("Reading a complete new snapshot...", async position => {
    $("#cancel-read").hidden = false;
    const next = await api("refresh", { filters });
    answers = null; contacts = null;
    await acceptReport(next, false);
    restorePosition = position;
});
$("#reset").onclick = () => work("Resetting cohort filters...", async () => {
    const next = await api("filter", { filters: {} });
    filters = {}; answers = null; contacts = null; await acceptReport(next); saveView();
});
$("#population").onchange = () => work("Applying response population...", async () => {
    const next = await api("filter", { filters, population: $("#population").value });
    answers = null; contacts = null; answerPage = 0;
    await acceptReport(next);
});
$("#cancel-read").onclick = () => api("cancel").catch(error => {
    $("#error").textContent = error.message; $("#error").hidden = false;
});
$("#connect-form").onsubmit = event => {
    event.preventDefault();
    work("Sign in in your browser. The read can take several minutes...", async () => {
        const result = await api("signin", { environment: $("#environment").value.trim(),
            tenant: $("#tenant").value.trim(), clientId: $("#client-id").value.trim() });
        $("#connection").textContent = "Signed in. Select one survey for a complete read.";
        $("#live-surveys").innerHTML = result.surveys.map(s =>
            `<button data-live-survey="${s.id}">${escape(s.title)}</button>`).join("")
            || "<p>No surveys are readable in this environment.</p>";
        $("#live-surveys").querySelectorAll("button").forEach(button => {
            button.onclick = () => work("Reading all pages of the selected survey...", async () => {
                $("#cancel-read").hidden = false;
                proposal = await api("inspect", { surveyId: button.dataset.liveSurvey });
                renderMapping();
            });
        });
    });
};
$("#browse-export").onclick = () => work("Select an export in the system file dialog...", async () => {
    const result = await api("browse");
    if (result.path !== null) $("#path").value = result.path;
});

function showTooltip(segment, x, y) {
    const tooltip = $("#chart-tooltip");
    tooltip.textContent = segment.dataset.tooltip;
    tooltip.hidden = false;
    const rect = segment.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(x ?? rect.left, innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min((y ?? rect.bottom) + 10, innerHeight - tooltip.offsetHeight - 8))}px`;
}
document.addEventListener("pointerover", event => {
    const segment = event.target.closest("[data-tooltip]");
    if (segment) showTooltip(segment, event.clientX, event.clientY);
});
document.addEventListener("pointerout", event => {
    if (event.target.closest("[data-tooltip]")) $("#chart-tooltip").hidden = true;
});
document.addEventListener("focusin", event => {
    const segment = event.target.closest("[data-tooltip]");
    if (segment) showTooltip(segment);
});
document.addEventListener("focusout", () => { $("#chart-tooltip").hidden = true; });
document.addEventListener("keydown", event => {
    if (event.key === "Escape") $("#chart-tooltip").hidden = true;
});
window.addEventListener("pagehide", saveView);
document.addEventListener("scrollend", () => {
    if (!restorePosition && $("#status").textContent === "") saveView();
}, true);

async function openSaved(id) {
    const next = await api("open", { id });
    const saved = next.view || {};
    ({ selected, tab = "overview", answerSearch = "", questionSearch = "", answerPage = 0, filters = {} } = saved);
    answers = null; contacts = null;
    await acceptReport(next, false);
    restorePosition = { scroll: saved.scroll || 0, listScroll: saved.listScroll || 0 };
}

function renderLibrary(surveys, warnings = []) {
    $("#library-warning").hidden = !warnings.length;
    $("#library-warning").textContent = warnings.join(" ");
    $("#library").innerHTML = surveys.length
        ? surveys.map(s => `<button data-survey="${s.id}">${escape(s.title)}<br><span class="fine">${escape(s.source)}</span></button>`).join("")
        : '<p class="fine">Your confirmed survey profiles will appear here.</p>';
    $("#library").querySelectorAll("button").forEach(button => {
        button.onclick = () => work("Opening saved survey...", () => openSaved(button.dataset.survey));
    });
}

await work("Loading survey library...", async () => {
    const config = await api("config");
    $("#reuse-profile").innerHTML = options([["", "New survey"], ...config.surveys.map(s => [s.id, s.title])]);
    $("#connection").textContent = config.connection;
    renderLibrary(config.surveys, config.warnings);
    if (config.input.surveyId) await openSaved(config.input.surveyId);
    else if (config.input.source) {
        $("#path").value = config.input.source; showSetup();
    }
});
