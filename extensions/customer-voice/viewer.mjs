import { chartOptions, chartLabel, questionGraphic } from "./presentation.mjs";
import { viewerThemes, chartThemes, systemColors, validateAppearance, viewerColors, chartPalette, chartColor, contrast } from "./themes.mjs";
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const token = location.hash.slice(1);
let report, proposal, surveyId, selected, tab = "overview", answers, contacts;
let answerSearch = "", questionSearch = "", answerPage = 0, filters = {};
let restorePosition;
let editingQuestion;
let graphicQuestion, importedSettings;
let appearanceDraft;
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
      You can change them below. A change to a question type resets chart choices that no longer match.</div>
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
      <p class="notice">Follow-up uses one private email field and one consent rule at a time.
      Sweepstakes entry is not research consent. Use a separate research permission answer for a sweepstakes email field.
      Select the opt-in checkbox only when the email prompt itself states research consent.
      No branch rule is inferred from blank cells. Saved roles stay unchanged until you edit and save them.</p>
      <div class="mapping-list">${fields.map(f => `
        <details class="map-row" data-field="${f.id}">
          <summary>${f.id} / ${escape(f.label)} <span class="fine">[${escape(f.kind)}] / ${f.answered ?? "mapped"} answered</span></summary>
          <p class="fine">${escape(f.reason || "Saved mapping. Check against the current export.")}</p>
          ${proposal.profile.fields[f.index].kind !== f.kind ? `<p class="notice">The current import suggests
          ${escape(proposal.profile.fields[f.index].kind)}. The saved role remains ${escape(f.kind)} until you change it.
          ${escape(proposal.profile.fields[f.index].reason)}</p>` : ""}
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
        profile.presentations = Object.fromEntries(Object.entries(profile.presentations || {}).filter(([id, setting]) => {
            const field = fields.find(field => field.id === id);
            return field && !["private", "system", "metadata"].includes(field.kind) && chartOptions(field).includes(setting.chart);
        }));
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
    return `class="chart-segment ${extraClass}" role="img" tabindex="0" data-tooltip="${escape(text)}" aria-label="${escape(text)}" aria-describedby="chart-tooltip"`;
}

function metricCard(q, tools = false) {
    const m = q.metric;
    return `<article class="metric${tools ? " overview-card" : ""}"><p class="fine">${escape(q.label)}</p>
      <div class="metric-value">${m.value === null ? "Suppressed" : escape(m.value) + (m.label === "NPS" ? "" : "%")}</div>
      <h3>${escape(m.label)}</h3><p class="fine">${escape(m.status)} / n=${m.denominator}
      / numerator ${m.numerator}</p><p class="fine">${escape(m.method)}</p>${tools ? questionTools(q, true) : ""}</article>`;
}

function bars(q) {
    const chart = report.presentations?.[q.id]?.chart || "default";
    if (chart === "default") return originalBars(q) + questionData(q);
    if (chart === "table") return `<div class="table-wrap"><table><caption>${escape(q.label)}</caption>
      <thead><tr><th>Choice</th><th>Count</th><th>Percent</th></tr></thead><tbody>
      ${(q.distribution || []).map(item => `<tr><td>${escape(item.label)}</td><td>${item.count}</td><td>${item.percent}%</td></tr>`).join("")}
      </tbody></table></div><p class="fine">Denominator: ${q.valid} valid nonblank answers.
      ${q.multiSelect ? "Multiple selections. Percentages can sum above 100%." : ""} ${escape(q.units || "")}</p>`;
    return `<div class="graphic-scroll" tabindex="0" role="region" aria-label="${escape(q.label)} chart. Scroll to see the full graphic.">${questionGraphic(q, chart, "", report.appearance)}</div>${questionData(q)}`;
}

function questionData(q) {
    if (!q.distribution) return "";
    return `<details class="chart-data"${matchMedia("(forced-colors: active)").matches ? " open" : ""}><summary>View data: ${escape(q.label)}</summary>
      <p class="fine">Labels and numbers identify segments. ${q.kind === "nps" && (!report.presentations?.[q.id] || report.presentations[q.id].chart === "default")
        ? "Columns use score labels. The group bar uses the three numbered group labels; the table below lists individual scores."
        : "Nonzero segments follow this row order from left to right, or clockwise from the top."}</p>
      <div class="table-wrap" tabindex="0" role="region" aria-label="${escape(q.label)} data">
      <table><caption>${escape(q.label)}: ${q.valid} valid answers</caption><thead><tr><th scope="col">No.</th><th scope="col">Choice</th><th scope="col">Count</th><th scope="col">Percent</th></tr></thead><tbody>
      ${q.distribution.map((item, index) => `<tr><td>${index + 1}</td><th scope="row">${escape(item.label)}</th><td>${item.count}</td><td>${item.percent}%</td></tr>`).join("")}</tbody></table></div></details>`;
}

function questionTools(q, compact = false) {
    if (compact) return `<div class="actions question-tools compact-actions">
      <button data-edit-question="${q.id}" aria-label="Edit question: ${escape(q.label)}" title="Edit question presentation">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg></button>
      <button data-export-question="${q.id}" aria-label="Export graphic: ${escape(q.label)}" title="Export question graphic">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/></svg></button>
      </div>`;
    return `<div class="actions question-tools"><button data-edit-question="${q.id}">Edit</button>
      <button data-export-question="${q.id}">Export graphic</button></div>`;
}

function originalBars(q) {
    if (q.kind === "nps") {
        const max = Math.max(1, ...q.distribution.map(x => x.count));
        const colors = chartPalette(report.appearance).nps;
        return `<div class="histogram" role="group" aria-label="Recommendation score counts from zero through ten. Full values are in View data.">${q.distribution.map(x => `
          <div class="hist-col"><span>${x.count}</span><div ${tip(`Score ${x.label}`, x.count, x.percent, q.valid, "hist-bar")} style="height:${Math.max(1, x.count / max * 145)}px;background:${colors[+x.label <= 6 ? 0 : +x.label <= 8 ? 1 : 2]}"></div>${x.label}</div>`).join("")}</div>
          ${q.metric ? `<div class="balance">${["detractors", "passives", "promoters"].map((key, i) => `
          <div ${tip(["Detractors (0-6)", "Passives (7-8)", "Promoters (9-10)"][i], q.metric[key],
              q.valid ? Math.round(q.metric[key] / q.valid * 1000) / 10 : 0, q.valid)}
            style="width:${q.valid ? q.metric[key] / q.valid * 100 : 0}%;background:${colors[i]}"><span class="segment-number" aria-hidden="true">${i + 1}</span></div>`).join("")}</div>
          <div class="legend">${["Detractors (0-6)", "Passives (7-8)", "Promoters (9-10)"].map((label, i) =>
              `<span><i class="swatch" style="background:${colors[i]}" aria-hidden="true"></i>${i + 1}. ${label}: ${q.metric[["detractors", "passives", "promoters"][i]]}</span>`).join("")}</div>` : ""}`;
    }
    if (!q.distribution) return `<p class="notice">${q.kind === "text"
        ? "Read the written answers in All questions." : "This field has no confirmed chart mapping."}</p>`;
    const stacked = q.kind === "ordered" ? `<div class="balance">${q.distribution.map((d, i) =>
        `<div ${tip(d.label, d.count, d.percent, q.valid)} style="width:${d.percent}%;background:${scaleColor(i, q.distribution.length)}"><span class="segment-number" aria-hidden="true">${i + 1}</span></div>`).join("")}</div>` : "";
    const palette = chartPalette(report.appearance);
    return `${stacked}<div class="horizontal">${q.distribution.map((d, index) => `
      <div class="bar-row"><div class="bar-label">${escape(d.label)}</div>
        <div class="bar-track"><div ${tip(d.label, d.count, d.percent, q.valid)} style="width:${Math.min(100, d.percent)}%;height:100%;background:${chartColor(index, q.distribution.length, palette)};border-radius:3px"></div></div>
        <div class="bar-value">${d.count} / ${d.percent}%</div></div>`).join("")}</div>
      <p class="fine">Denominator: ${q.valid} valid nonblank answers. ${q.multiSelect
        ? "Multiple selections: each respondent counts once per choice. Percentages can sum above 100%." : ""}
        ${escape(q.units || "")}</p>`;
}

function scaleColor(index, length) {
    return chartColor(index, length, chartPalette(report.appearance));
}

function matrix(group, questions) {
    const domain = questions[0].distribution?.map(d => d.label);
    if (!domain || !questions.every(q => q.kind === "ordered"
        && JSON.stringify(q.distribution.map(d => d.label)) === JSON.stringify(domain))) return "";
    const colors = domain.map((_, i) => scaleColor(i, domain.length));
    return `<section class="panel"><h3>${escape(group)}</h3><div class="legend">${domain.map((v, i) =>
        `<span><i class="swatch" style="background:${colors[i]}" aria-hidden="true"></i>${i + 1}. ${escape(v)}</span>`).join("")}</div>
      ${questions.map(q => `<div class="bar-row"><span>${escape(q.label)}</span><div class="balance">
      ${q.distribution.map((d, index) => `<div ${tip(d.label, d.count, d.percent, q.valid)} style="width:${d.percent}%;background:${colors[index]}"><span class="segment-number" aria-hidden="true">${index + 1}</span></div>`).join("")}
      </div><span class="fine">n=${q.valid}</span></div>${questionData(q)}`).join("")}</section>`;
}

function surveyQuestions() {
    return report.questions.filter(q => !["system", "metadata", "private"].includes(q.kind));
}

function renderSection(group) {
    const questions = surveyQuestions().filter(q => q.group === group);
    return `<p class="overline">SURVEY SECTION</p><h2>${escape(group)}</h2>
      <p class="fine">${questions.length} questions. Sections use profile group labels, not recovered survey pages.</p>
      ${matrix(group, questions)}
      <div class="grid">${questions.map(q => `<article class="panel"><h3>${escape(q.label)}</h3>${questionTools(q)}
        ${q.metric ? metricCard(q) : ""}
        ${q.kind === "text" && report.presentations?.[q.id]?.chart !== "summary"
            ? `<p class="fine">${q.answered} written answers</p><button data-read-question="${q.id}">Read all answers</button>` : bars(q)}</article>`).join("")}</div>`;
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
      ${metrics.map(q => metricCard(q, true)).join("")}</div>
      ${groups.map(group => matrix(group, questions.filter(q => q.group === group))).join("")}
      <div class="grid">${questions.filter(q => q.distribution).slice(0, 8).map(q => `
      <article class="panel overview-card"><h3>${escape(q.label)}</h3>${bars(q)}${questionTools(q, true)}</article>`).join("")}</div>
      ${renderSourceGroups()}<p class="notice">All questions lists report questions, not private fields or export metadata.
      Use Method and column audit to account for every source column. This overview shows the first eight charted questions.
      No overall satisfaction score is inferred.</p>`;
}

function renderPrivateFields() {
    const fields = report.questions.filter(q => q.kind === "private");
    if (!fields.length) return "";
    return `<details class="notice private-fields"><summary>${fields.length} private source fields are not in the question list</summary>
      <p>These fields were imported. Values stay out of charts, written answers, chat analysis, and shared presentation settings.
      Use Private follow-up for research contacts allowed by a saved consent mapping.
      Use Review profile to check roles and consent. Use Method and column audit for all source columns.</p>
      <p>Blank cells do not show whether a question was displayed. Sweepstakes entry is not research consent.
      Review sweepstakes addresses in the private source export, not in this research directory.</p>
      <ul>${fields.map(q => `<li>${q.id} / ${escape(q.label)} / ${q.answered} answered / ${q.blank} blank</li>`).join("")}</ul>
      </details>`;
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
      ${questionTools(q)}
      <details><summary>Original source wording</summary><p class="fine">${escape(q.header)}</p></details>
      <div class="stats"><div><strong>${q.answered}</strong>Answered</div><div><strong>${q.blank}</strong>Blank</div>
      <div><strong>${q.valid}</strong>Valid nonblank</div><div><strong>${q.excluded}</strong>Excluded</div></div>
      ${q.metric ? metricCard(q) : ""}
      ${q.kind === "text" && report.presentations?.[q.id]?.chart !== "summary" ? `<div class="notice">${escape(report.warning)}</div>
        <div class="answer-tools"><label>Search all written answers<input id="answer-search" value="${escape(answerSearch)}"></label>
        <span class="fine" id="answer-count"></span></div><div id="answer-list"></div><div id="answer-pagination" class="pagination"></div>`
        : bars(q)}`;
    if (q.kind === "text" && report.presentations?.[q.id]?.chart !== "summary") {
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
          <p class="fine">${questions.length} questions / ${report.questions.length} source columns</p>
          ${renderPrivateFields()}<div id="question-list"></div>
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
          ${renderPrivateFields()}
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
    report.appearance = validateAppearance(result.appearance);
    applyAppearance();
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
async function reviewProfile() {
    proposal = await api("review"); renderMapping();
}
$("#review-profile").onclick = () => work("Opening profile settings...", reviewProfile);
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

function showTooltip(segment) {
    const tooltip = $("#chart-tooltip");
    tooltip.textContent = segment.dataset.tooltip;
    tooltip.hidden = false;
    const rect = segment.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(0, rect.bottom + tooltip.offsetHeight <= innerHeight
        ? rect.bottom : rect.top - tooltip.offsetHeight)}px`;
}
document.addEventListener("pointerover", event => {
    const segment = event.target.closest("[data-tooltip]");
    if (segment) showTooltip(segment);
});
document.addEventListener("pointerout", event => {
    if ((event.target.closest("[data-tooltip]") || event.target.closest("#chart-tooltip"))
        && !event.relatedTarget?.closest("[data-tooltip],#chart-tooltip")) $("#chart-tooltip").hidden = true;
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

document.addEventListener("click", event => {
    const exportButton = event.target.closest("[data-export-question]");
    if (exportButton) {
        graphicQuestion = report.questions.find(q => q.id === exportButton.dataset.exportQuestion);
        $("#graphic-question").textContent = graphicQuestion.label;
        $("#graphic-dialog").showModal();
        return;
    }
    const button = event.target.closest("[data-edit-question]");
    if (!button) return;
    editingQuestion = report.questions.find(q => q.id === button.dataset.editQuestion);
    $("#presentation-question").textContent = editingQuestion.label;
    $("#presentation-chart").innerHTML = options(chartOptions(editingQuestion).map(chart => [chart, chartLabel(chart)]),
        report.presentations?.[editingQuestion.id]?.chart || "default");
    $("#save-presentation").disabled = Boolean(report.preview);
    $("#save-presentation").dataset.disabled = String(Boolean(report.preview));
    $("#presentation-dialog").showModal();
});
$("#cancel-presentation").onclick = () => $("#presentation-dialog").close();
$("#presentation-form").onsubmit = event => {
    event.preventDefault();
    work("Saving question presentation...", async () => {
        const chart = $("#presentation-chart").value;
        $("#presentation-dialog").close();
        const next = await api("presentation", { surveyId,
            presentations: { ...report.presentations, [editingQuestion.id]: { chart } } });
        await acceptReport(next);
    });
};

function download(blob, filename) {
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function graphicContext() {
    const scope = report.scope;
    const cohort = Object.entries(scope.filters).map(([id, value]) => {
        const field = report.filterOptions.find(field => field.id === id);
        return `${field?.label || id}: ${value}`;
    }).join("; ") || "None";
    return `${report.title}. ${scope.population} ${scope.selected} selected responses. Filters: ${cohort}.`;
}

async function exportGraphic(format) {
    const svg = questionGraphic(graphicQuestion, report.presentations?.[graphicQuestion.id]?.chart || "default", graphicContext(), report.appearance);
    const xml = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (xml.querySelector("parsererror")) throw new Error("A question label contains text that SVG cannot use. Check the labels before export.");
    let blob = new Blob([svg], { type: "image/svg+xml" });
    if (format === "png") {
        const scale = 2, width = Number(xml.documentElement.getAttribute("width")) * scale;
        const height = Number(xml.documentElement.getAttribute("height")) * scale;
        if (height > 16000 || width * height > 32000000) throw new Error("This question is too large for PNG. Export SVG instead.");
        const image = new Image();
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser cannot create a PNG graphic. Export SVG instead.");
        context.drawImage(image, 0, 0, width, height);
        blob = await new Promise((accept, reject) => canvas.toBlob(value => value ? accept(value)
            : reject(new Error("Cannot create the PNG graphic. Export SVG instead.")), "image/png"));
    }
    download(blob, `question-${graphicQuestion.id}.${format}`);
}

$("#cancel-graphic").onclick = () => $("#graphic-dialog").close();
for (const format of ["svg", "png"]) $(`#export-${format}`).onclick = () => {
    $("#graphic-dialog").close();
    work("Creating question graphic...", () => exportGraphic(format));
};
$("#export-settings").onclick = () => work("Exporting presentation settings...", async () => {
    const settings = await api("settings", { surveyId, action: "export" });
    download(new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" }), "report-presentation.json");
});
$("#import-settings").onclick = () => $("#settings-file").click();
$("#settings-file").onchange = event => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    work("Checking presentation settings...", async () => {
        if (file.size > 2 * 1024 * 1024) throw new Error("The settings file is too large. The limit is 2 MiB.");
        let settings;
        try { settings = JSON.parse(await file.text()); }
        catch (error) {
            if (error instanceof SyntaxError) throw new Error("The settings file is not valid JSON.");
            throw error;
        }
        const checked = await api("settings", { surveyId, action: "check", settings });
        importedSettings = { surveyId, settings };
        $("#settings-summary").textContent = `${Object.keys(checked.presentations).length} question settings match this report.${settings.version === 2 ? " Viewer and chart themes are included." : " This older file keeps your current theme colors."}`;
        $("#settings-dialog").showModal();
    });
};
$("#cancel-settings").onclick = () => { importedSettings = null; $("#settings-dialog").close(); };
$("#apply-settings").onclick = () => {
    $("#settings-dialog").close();
    work("Saving imported presentation settings...", async () => {
        const next = await api("settings", { ...importedSettings, action: "apply" });
        importedSettings = null;
        await acceptReport(next);
    });
};

function applyAppearance() {
    const colors = viewerColors(report.appearance) || systemColors[matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"], root = document.documentElement;
    for (const key of ["paper", "ink", "muted", "accent", "line"]) {
        root.style.setProperty(`--${key}`, colors[key]);
    }
    root.style.colorScheme = contrast(colors.paper, "#ffffff") > 3 ? "dark" : "light";
    const palette = chartPalette(report.appearance);
    root.style.setProperty("--chart-accent", palette.colors?.[0] || "#3e6e9a");
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (report) applyAppearance(); });
matchMedia("(forced-colors: active)").addEventListener("change", event => {
    if (event.matches) document.querySelectorAll(".chart-data").forEach(details => details.open = true);
});

function customViewerValue() {
    return { name: $("#custom-viewer-name").value, colors: Object.fromEntries(
        [...document.querySelectorAll("[data-viewer-color]")].map(input => [input.dataset.viewerColor, $(`#hex-${input.id}`).value])) };
}

function customChartValue() {
    return { name: $("#custom-chart-name").value,
        colors: [...document.querySelectorAll("[data-chart-color]")].map(input => $(`#hex-${input.id}`).value),
        nps: [...document.querySelectorAll("[data-nps-color]")].map(input => $(`#hex-${input.id}`).value) };
}

function previewAppearance() {
    document.querySelectorAll("[data-viewer-theme]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.viewerTheme === appearanceDraft.viewer)));
    document.querySelectorAll("[data-chart-theme]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.chartTheme === appearanceDraft.chart)));
    try {
        const value = validateAppearance(appearanceDraft, { editing: true });
        const colors = viewerColors(value) || systemColors[matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"], palette = chartPalette(value);
        for (const [type, custom] of [["viewer", value.customViewer], ["chart", value.customChart]]) {
            if (!custom) continue;
            const button = document.querySelector(`[data-${type}-theme="custom"]`);
            button.querySelector("span:last-child").textContent = custom.name;
            const samples = type === "viewer" ? Object.values(custom.colors).slice(0, 4) : custom.colors;
            button.querySelectorAll("i").forEach((sample, index) => sample.style.background = samples[index]);
        }
        $("#theme-preview").style.cssText = `background:${colors.paper};color:${colors.ink};border-color:${colors.line}`;
        $("#theme-preview").innerHTML = `<div><strong>Your report</strong><span style="color:${colors.muted}">Category colors follow the selected scale. NPS Original view uses the three group colors below. Alternative NPS charts use the category scale.</span></div>
          <div class="preview-bars" aria-hidden="true">${[48, 72, 90, 62, 80, 52].map((height, index) =>
              `<i data-preview-color="${index}" style="height:${height}%;background:${chartColor(index, 6, palette)};border:1px solid ${colors.ink};outline:1px solid ${colors.paper}"></i>`).join("")}</div>
          <div class="legend preview-nps">${["Detractors", "Passives", "Promoters"].map((label, index) =>
              `<span style="color:${colors.ink}"><i class="swatch" data-preview-nps="${index}" style="background:${palette.nps[index]};border-color:${colors.ink};outline-color:${colors.paper}" aria-hidden="true"></i>${label}</span>`).join("")}</div>`;
        $("#appearance-error").hidden = true;
        $("#repair-colors").hidden = true;
        $("#appearance-error").textContent = "";
        return value;
    } catch (error) {
        $("#appearance-error").hidden = false;
        $("#repair-colors").hidden = false;
        $("#appearance-error").textContent = `${error.message} The preview keeps the last valid colors.`;
        return null;
    }
}

function openAppearance(value = report.appearance) {
    appearanceDraft = structuredClone(value);
    const customViewer = appearanceDraft.customViewer || { name: "My viewer theme", colors: viewerColors(report.appearance) || viewerThemes[1].colors };
    const customChart = appearanceDraft.customChart || { name: "My chart palette", colors: chartPalette(report.appearance).colors || chartThemes[1].colors, nps: chartPalette(report.appearance).nps };
    const samples = colors => `<span class="theme-samples" aria-hidden="true">${colors.map(color => `<i style="background:${color}"></i>`).join("")}</span>`;
    const colorControl = (label, type, key, color) => {
        const id = `${type}-${key}`;
        return `<div><label>${escape(label)}<input id="${id}" type="color" data-${type}-color="${key}" value="${color}"></label>
          <label class="sr-only" for="hex-${id}">${escape(label)} hex value</label><input id="hex-${id}" data-hex="${id}" value="${color}" maxlength="7" spellcheck="false" aria-describedby="color-help appearance-error"></div>`;
    };
    $("#viewer-themes").innerHTML = [...viewerThemes, { id: "custom", name: "Custom viewer", colors: customViewer.colors }].map(theme =>
        `<button class="theme-choice" type="button" data-viewer-theme="${theme.id}" aria-pressed="false">
          ${samples(Object.values(theme.colors || viewerThemes[1].colors).slice(0, 4))}<span>${escape(theme.name)}</span></button>`).join("");
    $("#chart-themes").innerHTML = [...chartThemes, { id: "custom", name: "Custom palette", colors: customChart.colors }].map(theme =>
        `<button class="theme-choice" type="button" data-chart-theme="${theme.id}" aria-pressed="false">
          ${samples(theme.colors || Array.from({ length: 6 }, (_, index) => chartColor(index, 6, theme)))}<span>${escape(theme.name)}</span></button>`).join("");
    $("#custom-viewer-name").value = customViewer.name;
    $("#custom-chart-name").value = customChart.name;
    $("#viewer-color-inputs").innerHTML = Object.entries(customViewer.colors).map(([key, color]) =>
        colorControl({ paper: "Background", ink: "Text", muted: "Muted text", accent: "Accent", line: "Dividers" }[key], "viewer", key, color)).join("");
    $("#chart-color-inputs").innerHTML = customChart.colors.map((color, index) =>
        colorControl(`Color ${index + 1}`, "chart", index, color)).join("") +
        customChart.nps.map((color, index) => colorControl(["Detractors", "Passives", "Promoters"][index], "nps", index, color)).join("");
    $("#viewer-themes").querySelectorAll("button").forEach(button => {
        button.onclick = () => {
            if (button.dataset.viewerTheme === "custom") appearanceDraft.customViewer = customViewerValue();
            appearanceDraft.viewer = button.dataset.viewerTheme; previewAppearance();
        };
    });
    $("#chart-themes").querySelectorAll("button").forEach(button => {
        button.onclick = () => {
            if (button.dataset.chartTheme === "custom") appearanceDraft.customChart = customChartValue();
            appearanceDraft.chart = button.dataset.chartTheme; previewAppearance();
        };
    });
    for (const input of document.querySelectorAll("#custom-viewer-name,[data-viewer-color]")) input.oninput = () => {
        if (input.type === "color") $(`#hex-${input.id}`).value = input.value;
        appearanceDraft.customViewer = customViewerValue(); appearanceDraft.viewer = "custom"; previewAppearance();
    };
    for (const input of document.querySelectorAll("#custom-chart-name,[data-chart-color],[data-nps-color]")) input.oninput = () => {
        if (input.type === "color") $(`#hex-${input.id}`).value = input.value;
        appearanceDraft.customChart = customChartValue(); appearanceDraft.chart = "custom"; previewAppearance();
    };
    for (const input of document.querySelectorAll("[data-hex]")) input.oninput = () => {
        const color = $(`#${input.dataset.hex}`);
        if (/^#[0-9a-f]{6}$/i.test(input.value)) color.value = input.value;
        if (color.dataset.viewerColor) {
            appearanceDraft.customViewer = customViewerValue(); appearanceDraft.viewer = "custom";
        } else {
            appearanceDraft.customChart = customChartValue(); appearanceDraft.chart = "custom";
        }
        previewAppearance();
    };
    $("#save-appearance").textContent = report.preview ? "Apply appearance" : "Save appearance";
    $("#save-appearance").setAttribute("aria-describedby", report.preview ? "appearance-preview-notice" : "");
    $("#save-appearance-profile").hidden = !report.preview;
    $("#appearance-preview-notice").hidden = !report.preview;
    previewAppearance();
    $("#appearance-dialog").showModal();
}
$("#open-appearance").onclick = () => openAppearance();
$("#cancel-appearance").onclick = () => $("#appearance-dialog").close();
$("#repair-colors").onclick = () => {
    if (appearanceDraft.customViewer) {
        appearanceDraft.customViewer.colors = structuredClone(viewerThemes[1].colors);
        appearanceDraft.customViewer.name = appearanceDraft.customViewer.name.trim() || "My viewer theme";
    }
    if (appearanceDraft.customChart) {
        appearanceDraft.customChart.colors = [...chartThemes[4].colors];
        appearanceDraft.customChart.nps = [...chartThemes[4].nps];
        appearanceDraft.customChart.name = appearanceDraft.customChart.name.trim() || "My chart palette";
    }
    openAppearance(appearanceDraft);
};
$("#appearance-form").onsubmit = event => {
    event.preventDefault();
    const appearance = previewAppearance();
    if (!appearance) { $("#appearance-error").focus(); return; }
    const review = report.preview && event.submitter?.id === "save-appearance-profile";
    const message = report.preview ? "Applying viewer and chart colors..." : "Saving viewer and chart colors...";
    $("#appearance-dialog").close();
    work(message, async () => {
        const next = await api("appearance", { surveyId, appearance });
        if (!$("#mapping").hidden && proposal?.edit?.id === next.surveyId) {
            proposal.edit.appearance = structuredClone(next.appearance);
        }
        await acceptReport(next);
        if (review) await reviewProfile();
    });
};

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
