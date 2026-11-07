import { validateAppearance, chartPalette, chartColor } from "./themes.mjs";
const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const chartNames = {
    default: "Original view", horizontal: "Horizontal bars", vertical: "Column chart",
    dot: "Dot plot", stacked: "100% stacked bar", pie: "Pie chart", donut: "Donut chart",
    table: "Data table", summary: "Answer summary", answers: "Written answers",
};

export function chartOptions(question) {
    if (question.kind === "text") return ["default", "answers", "summary"];
    if (!["choice", "multiple", "ordered", "nps", "number", "date"].includes(question.kind)) {
        return ["default", "summary"];
    }
    const charts = ["default", "horizontal", "vertical", "dot", "table"];
    if (["choice", "ordered", "nps"].includes(question.kind)) charts.push("stacked", "pie", "donut");
    return charts;
}

export const chartLabel = chart => chartNames[chart];

export function validatePresentations(profile, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid chart settings.");
    const result = {};
    for (const [id, setting] of Object.entries(value)) {
        const field = profile.fields.find(field => field.id === id);
        if (!field || ["private", "system", "metadata"].includes(field.kind)
            || !setting || Object.keys(setting).length !== 1
            || !chartOptions(field).includes(setting.chart)) throw new Error("A chart does not match its question type.");
        result[id] = { chart: setting.chart };
    }
    return result;
}

const visibleFields = profile => profile.fields.filter(field => !["private", "system", "metadata"].includes(field.kind));

export function exportSettings(profile) {
    return {
        format: "customer-voice-presentation", version: 2,
        appearance: validateAppearance(profile.appearance),
        questions: visibleFields(profile).map(field => ({
            id: field.id, header: field.header, kind: field.kind,
            ...(profile.columnIds ? { sourceId: profile.columnIds[field.index] } : {}),
            chart: profile.presentations?.[field.id]?.chart || "default",
        })),
    };
}

export function importSettings(profile, settings) {
    if (!settings || settings.format !== "customer-voice-presentation" || ![1, 2].includes(settings.version)
        || Object.keys(settings).sort().join(",") !== (settings.version === 1 ? "format,questions,version" : "appearance,format,questions,version")
        || !Array.isArray(settings.questions)) throw new Error("Select a Customer Voice presentation settings file (version 1 or 2).");
    if (settings.version === 2) validateAppearance(settings.appearance);
    const fields = visibleFields(profile);
    if (fields.length !== settings.questions.length) throw new Error("The settings belong to a different report structure.");
    const presentations = {};
    fields.forEach((field, index) => {
        const q = settings.questions[index];
        if (!q || Object.keys(q).sort().join(",") !== (profile.columnIds ? "chart,header,id,kind,sourceId" : "chart,header,id,kind")
            || q.id !== field.id || q.header !== field.header || q.kind !== field.kind
            || profile.columnIds && q.sourceId !== profile.columnIds[field.index]) {
            throw new Error("The settings do not match this report's question identities and types. No settings were changed.");
        }
        presentations[field.id] = { chart: q.chart };
    });
    return validatePresentations(profile, presentations);
}

function lines(value, width = 70) {
    const output = [];
    for (const paragraph of String(value).split(/\r?\n/)) {
        let line = "";
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            const characters = Array.from(word);
            for (let start = 0; start < characters.length; start += width) {
                const part = characters.slice(start, start + width).join("");
                if (line && line.length + part.length + 1 > width) { output.push(line); line = ""; }
                line += (line ? " " : "") + part;
            }
        }
        output.push(line);
    }
    return output;
}

export function questionGraphic(question, chart = "default", context = "", appearance) {
    if (!chartOptions(question).includes(chart)) throw new Error("This chart is not available for this question.");
    const q = question, width = 1000, palette = chartPalette(validateAppearance(appearance));
    let y = 38, content = "";
    const text = (value, x = 30, size = 16, wrap = 90) => {
        for (const line of lines(value, Math.min(wrap, Math.floor((width - x - 30) / size)))) {
            content += `<text x="${x}" y="${y}" font-size="${size}">${escape(line)}</text>`;
            y += size + 8;
        }
    };
    text(q.label, 30, 24, 64);
    text(context, 30, 14, 110);
    text(`${q.answered} answered / ${q.blank} blank / ${q.valid} valid / ${q.excluded} excluded`, 30, 14);
    if (q.metric) {
        const score = q.metric.value === null ? "Suppressed" : `${q.metric.value}${q.metric.label === "NPS" ? "" : "%"}`;
        text(`${q.metric.label}: ${score} / n=${q.metric.denominator}. ${q.metric.method}`, 30, 14, 110);
    }
    const data = q.distribution || [], total = data.reduce((sum, item) => sum + item.count, 0);
    const color = index => q.kind === "nps" && chart === "default"
        ? palette.nps[+data[index].label <= 6 ? 0 : +data[index].label <= 8 ? 1 : 2]
        : chartColor(index, data.length, palette);
    const segment = (item, shape) => {
        const label = `${item.label}: ${item.percent}% / ${item.count} of ${q.valid} valid answers`;
        const halo = shape.replace(/fill="[^"]+"/, 'fill="none"').replace("/>",
            ' class="mark-halo" stroke="#ffffff" stroke-width="4" stroke-linejoin="round"/>');
        const mark = shape.replace("/>", ' class="chart-mark" stroke="#23352f" stroke-width="1.5" stroke-linejoin="round"/>');
        return `<g class="chart-segment" role="img" tabindex="0" data-tooltip="${escape(label)}" aria-label="${escape(label)}"><title>${escape(label)}</title>${halo}${mark}</g>`;
    };
    const number = (index, x, row) => `<text class="chart-number" x="${x}" y="${row}" text-anchor="middle" font-size="12" font-weight="bold" fill="#23352f" stroke="#ffffff" stroke-width="5" paint-order="stroke fill" aria-hidden="true">${index + 1}</text>`;
    const actual = chart === "default" ? q.kind === "nps" ? "vertical" : "horizontal" : chart;
    if (!data.length || actual === "summary" || actual === "answers") {
        if (q.kind === "text") {
            text("Written answers are private.", 30, 16);
            text("This graphic contains counts only.", 30, 16);
        } else text("No distribution is available.", 30, 16);
    } else if (actual === "table") {
        content += `<text x="30" y="${y}" font-weight="bold">Choice</text><text x="760" y="${y}" font-weight="bold">Count</text><text x="860" y="${y}" font-weight="bold">Percent</text>`;
        y += 30;
        data.forEach(item => {
            const row = y;
            text(item.label, 30, 16, 43);
            content += `<text x="760" y="${row}" font-size="16">${item.count}</text><text x="860" y="${row}" font-size="16">${item.percent}%</text><path d="M30 ${y} H970" stroke="#dce4dc"/>`;
            y += 20;
        });
    } else {
        let legendX = 30, chartBottom = 0;
        if (["stacked", "pie", "donut"].includes(actual) || chart === "default" && ["ordered", "nps"].includes(q.kind)) {
            if (!total) text("No valid answers.", 30, 16);
            else if (["pie", "donut"].includes(actual)) {
                text("Nonzero segments follow numbered rows clockwise from the top.", 30, 14);
                const cy = y + 145;
                let angle = -Math.PI / 2;
                let numbers = "";
                data.forEach((item, index) => {
                    if (!item.count) return;
                    const end = angle + item.count / total * Math.PI * 2;
                    const x1 = 210 + 130 * Math.cos(angle), y1 = cy + 130 * Math.sin(angle);
                    const x2 = 210 + 130 * Math.cos(end), y2 = cy + 130 * Math.sin(end);
                    content += segment(item, item.count === total
                        ? `<circle cx="210" cy="${cy}" r="130" fill="${color(index)}"/>`
                        : `<path d="M210 ${cy} L${x1} ${y1} A130 130 0 ${end - angle > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z" fill="${color(index)}"/>`);
                    if (item.count / total >= .04 && data.length <= 12) {
                        const mid = (angle + end) / 2, radius = actual === "donut" ? 103 : 85;
                        numbers += number(index, 210 + radius * Math.cos(mid), cy + radius * Math.sin(mid) + 4);
                    }
                    angle = end;
                });
                if (actual === "donut") content += `<circle cx="210" cy="${cy}" r="75" fill="#ffffff"/>`;
                content += numbers;
                chartBottom = y + 305;
                y += 30;
                legendX = 410;
            } else {
                let x = 30;
                const stack = chart === "default" && q.kind === "nps" && q.metric
                    ? [["detractors", "Detractors (0-6)"], ["passives", "Passives (7-8)"], ["promoters", "Promoters (9-10)"]].map(([key, label]) => ({
                        label, count: q.metric[key], percent: q.valid ? Math.round(q.metric[key] / q.valid * 1000) / 10 : 0,
                    })) : data;
                content += '<g class="balance">';
                stack.forEach((item, index) => {
                    const size = item.count / total * 940;
                    const fill = stack === data ? color(index) : palette.nps[index];
                    content += segment(item, `<rect x="${x}" y="${y}" width="${size}" height="28" fill="${fill}"/>`);
                    if (size >= 24) content += number(index, x + size / 2, y + 19);
                    x += size;
                });
                content += "</g>";
                y += 52;
                text("Nonzero segments follow numbered rows from left to right.", 30, 14);
                if (stack !== data) stack.forEach((item, index) => text(`${index + 1}. ${item.label}: ${item.count} / ${item.percent}%`, 30, 14));
            }
        }
        if (actual === "vertical") {
            const max = Math.max(1, ...data.map(item => item.count)), top = y;
            const step = 940 / data.length;
            content += `<path class="chart-axis" d="M30 ${top} V${top + 180} H970" fill="none" stroke="#6b7771"/>`;
            data.forEach((item, index) => {
                const height = item.count / max * 180, x = 30 + index * step;
                content += segment(item, `<rect x="${x + step * .15}" y="${top + 180 - height}" width="${step * .7}" height="${height}" fill="${color(index)}"/>`);
                if (step >= 35) content += `<text x="${x + step / 2}" y="${top + 201}" text-anchor="middle" font-size="12">${q.kind === "nps" ? item.label : index + 1}</text>`;
            });
            y += 230;
            text(q.kind === "nps" ? "Recommendation scores: 0 to 10. Column heights show counts from zero."
                : "Columns start at zero. Numbers identify the choices below.", 30, 14);
        }
        data.forEach((item, index) => {
            const label = `${["vertical", "stacked", "pie", "donut"].includes(actual) && !(actual === "vertical" && q.kind === "nps") ? `${index + 1}. ` : ""}${item.label}`;
            const legend = ["vertical", "stacked", "pie", "donut"].includes(actual);
            if (legend) content += `<rect x="${legendX}" y="${y - 12}" width="12" height="12" fill="${color(index)}"/>`;
            text(label, legend ? legendX + 22 : 30, 16, 94);
            if (["horizontal", "dot"].includes(actual)) {
                const size = Math.min(100, item.percent) / 100 * 720;
                const fill = color(index);
                content += `<rect x="30" y="${y}" width="720" height="12" fill="#e8eeea"/>`;
                content += segment(item, actual === "dot"
                    ? `<circle cx="${30 + size}" cy="${y + 6}" r="7" fill="${fill}"/>`
                    : `<rect x="30" y="${y}" width="${size}" height="12" fill="${fill}"/>`);
                content += `<text x="780" y="${y + 12}" font-size="14">${item.count} / ${item.percent}%</text>`;
                y += 32;
            } else text(`${item.count} / ${item.percent}%`, legendX + 20, 14);
        });
        y = Math.max(y, chartBottom);
        if (["horizontal", "dot"].includes(actual)) text("Scale: 0 to 100% of valid answers.", 30, 14);
    }
    text(`Denominator: ${q.valid} valid nonblank answers. ${q.multiSelect ? "Multiple selections. Percentages can sum above 100%." : ""} ${q.units || ""}`, 30, 14, 110);
    return `<svg xmlns="http://www.w3.org/2000/svg" class="question-graphic" role="group" aria-label="${escape(q.label)}. ${q.valid} valid answers. Labels and counts follow the chart." viewBox="0 0 ${width} ${y + 20}" width="${width}" height="${y + 20}"><rect width="100%" height="100%" fill="#ffffff"/><g fill="#23352f" font-family="Arial, sans-serif">${content}</g></svg>`;
}
