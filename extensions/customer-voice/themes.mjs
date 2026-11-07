export const viewerThemes = [
    { id: "system", name: "Follow system", colors: null },
    { id: "studio", name: "Studio", colors: { paper: "#f8faff", ink: "#182940", muted: "#52637a", accent: "#285abb", line: "#cfd9eb" } },
    { id: "seaglass", name: "Sea glass", colors: { paper: "#f3faf7", ink: "#183c35", muted: "#47685e", accent: "#176954", line: "#c9ded5" } },
    { id: "iris", name: "Iris", colors: { paper: "#f7f5fc", ink: "#34284b", muted: "#6b587c", accent: "#7041ac", line: "#dbd2e8" } },
    { id: "midnight", name: "Midnight", colors: { paper: "#152239", ink: "#e7edf8", muted: "#abbbd5", accent: "#9dc4ff", line: "#40516a" } },
    { id: "graphite", name: "Graphite", colors: { paper: "#25292e", ink: "#f1f3f5", muted: "#b7bfc8", accent: "#9bd7d0", line: "#515b66" } },
    { id: "high-contrast", name: "High contrast", colors: { paper: "#ffffff", ink: "#111111", muted: "#353535", accent: "#004a99", line: "#666666" } },
];

export const systemColors = {
    light: { paper: "#fafbf8", ink: "#23352f", muted: "#536159", accent: "#285abb", line: "#dce4dc" },
    dark: { paper: "#16211f", ink: "#e0eae4", muted: "#a4b8ad", accent: "#8cb4df", line: "#34473d" },
};

export const chartThemes = [
    { id: "original", name: "Original", colors: null, nps: ["#b47783", "#6b7771", "#4a9b83"] },
    { id: "coast", name: "Coast", colors: ["#327e9e", "#4a927e", "#a58b41", "#6b78ac", "#ac678a", "#8d765b"], nps: ["#b45d71", "#87919d", "#38866e"] },
    { id: "orchid", name: "Orchid", colors: ["#8b64ab", "#b56385", "#577db2", "#36928e", "#a28545", "#647c68"], nps: ["#b56385", "#8c879b", "#36928e"] },
    { id: "woodland", name: "Woodland", colors: ["#43836e", "#8d8a47", "#ba754b", "#8d6ca1", "#447f9d", "#a65f74"], nps: ["#b56b4a", "#90866c", "#43836e"] },
    { id: "accessible", name: "Clear contrast", colors: ["#0072b2", "#d55e00", "#009e73", "#a76b9e", "#887014", "#5687a3"], nps: ["#d55e00", "#7d8590", "#0072b2"] },
];

const hex = value => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...names].sort().join(",");
const named = value => typeof value === "string" && value.trim().length > 0 && value.length <= 60;
const rgb = value => [1, 3, 5].map(start => parseInt(value.slice(start, start + 2), 16));
const luminance = value => rgb(value).map(channel => {
    const n = channel / 255;
    return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
}).reduce((sum, n, index) => sum + n * [.2126, .7152, .0722][index], 0);

export function contrast(a, b) {
    const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
}

export function mix(a, b, weight) {
    const first = rgb(a), second = rgb(b);
    return "#" + first.map((channel, index) => Math.round(channel * (1 - weight) + second[index] * weight)
        .toString(16).padStart(2, "0")).join("");
}

export function validateAppearance(value, { editing = false } = {}) {
    if (value === undefined) return { viewer: "system", chart: "original", customViewer: null, customChart: null };
    if (!keys(value, ["viewer", "chart", "customViewer", "customChart"])) throw new Error("Invalid theme settings.");
    const { viewer, chart, customViewer, customChart } = value;
    if (customViewer !== null) {
        if (!keys(customViewer, ["name", "colors"]) || !named(customViewer.name)
            || !keys(customViewer.colors, ["paper", "ink", "muted", "accent", "line"])
            || !Object.values(customViewer.colors).every(hex)) throw new Error("Use a theme name and six-digit hex viewer colors.");
        const c = customViewer.colors;
        const backgrounds = [c.paper, mix(c.paper, c.accent, .06), mix(c.paper, c.muted, .12)];
        for (const [key, label] of [["ink", "Text"], ["muted", "Muted text"]]) {
            if (backgrounds.some(background => contrast(c[key], background) < 4.5)) {
                throw new Error(`${label} needs at least 4.5:1 contrast on all report surfaces. Change this color or the background, or use readable custom colors.`);
            }
        }
        if (contrast(c.accent, c.paper) < 4.5) throw new Error("Accent needs at least 4.5:1 contrast against Background for button text. Change the accent or background, or use readable custom colors.");
    }
    if (customChart !== null && (!keys(customChart, ["name", "colors", "nps"]) || !named(customChart.name)
        || !Array.isArray(customChart.colors) || customChart.colors.length !== 6 || !customChart.colors.every(hex)
        || !Array.isArray(customChart.nps) || customChart.nps.length !== 3 || !customChart.nps.every(hex))) {
        throw new Error("Use a palette name, six chart colors, and three NPS group colors. Use six-digit hex values.");
    }
    if (editing && customChart) {
        for (const [label, colors] of [["Chart color", customChart.colors], ["NPS color", customChart.nps]]) {
            const index = colors.findIndex(color => contrast(color, "#ffffff") < 3);
            if (index >= 0) throw new Error(`${label} ${index + 1} needs at least 3:1 contrast against white exports. Choose a darker color, or use readable custom colors.`);
        }
    }
    if (!(viewerThemes.some(theme => theme.id === viewer) || viewer === "custom" && customViewer)
        || !(chartThemes.some(theme => theme.id === chart) || chart === "custom" && customChart)) {
        throw new Error("Select an available viewer theme and chart palette.");
    }
    return structuredClone(value);
}

export function viewerColors(appearance) {
    return appearance.viewer === "custom" ? appearance.customViewer.colors
        : viewerThemes.find(theme => theme.id === appearance.viewer).colors;
}

export function chartPalette(appearance) {
    return appearance.chart === "custom" ? appearance.customChart
        : chartThemes.find(theme => theme.id === appearance.chart);
}

export function chartColor(index, length, palette) {
    if (!palette.colors) {
        const hue = (205 - index * 120 / Math.max(1, length - 1)) / 60;
        const chroma = .432, x = chroma * (1 - Math.abs(hue % 2 - 1));
        const channels = hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : [0, x, chroma];
        let color = "#" + channels.map(n => Math.round((n + .264) * 255).toString(16).padStart(2, "0")).join("");
        while (contrast(color, "#ffffff") < 3.15) color = mix(color, "#000000", .04);
        return color;
    }
    const position = index / Math.max(1, length - 1) * (palette.colors.length - 1);
    const start = Math.floor(position), end = Math.min(start + 1, palette.colors.length - 1);
    return mix(palette.colors[start], palette.colors[end], position - start);
}
