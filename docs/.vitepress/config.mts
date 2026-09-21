import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { type DefaultTheme, defineConfig, type MarkdownEnv } from "vitepress";

// The markdown-it surface the rewrite rule needs, without depending on a
// transitive package.
type LinkToken = {
	type: string;
	attrGet(name: string): string | null;
	attrSet(name: string, value: string): void;
};
type BlockToken = LinkToken & { children?: LinkToken[] };
type CoreState = { tokens: BlockToken[]; env: Record<string, unknown> };
type Markdown = {
	core: { ruler: { push(name: string, fn: (state: CoreState) => void): void } };
	use(plugin: (md: Markdown) => void): void;
};

const srcDir = fileURLToPath(new URL("../", import.meta.url));
const srcDirPosix = srcDir.replace(/\\/g, "/");

// Repository-only content: these folders stay in the docs folder but out of
// the site build. This is the single declaration of the published subset.
const EXCLUDED = ["agents", "research", "verification"];

// Links from published pages into repository-only content (the excluded
// folders, or files outside the docs folder) are rewritten to the repository,
// so they keep working on the site.
const GITHUB = "https://github.com/SeriousJul/my-little-software-factory/blob/main";

// Returns a replacement for a markdown link target, or the original target
// when nothing changes. pagePath is the absolute path of the rendered page.
// A relative target resolves against the page; an absolute target (a leading
// "/") is a site path that resolves against the docs root. Either way, a
// target that reaches an excluded folder, or that leaves the docs folder,
// names repository-only content and is rewritten to the repository.
function rewriteLink(to: string, pagePath: string): string {
	if (to.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(to)) {
		return to;
	}
	const separator = to.indexOf("#");
	const hash = separator >= 0 ? to.slice(separator) : "";
	const target = separator >= 0 ? to.slice(0, separator) : to;
	const relative = to.startsWith("/")
		? posix.normalize(target.slice(1))
		: posix.relative(srcDirPosix, posix.normalize(posix.join(posix.dirname(pagePath), target)));
	if (relative.startsWith("..")) {
		return `${GITHUB}/${relative.replace(/^\.+\//, "")}${hash}`;
	}
	if (EXCLUDED.includes(relative.split("/")[0])) {
		return `${GITHUB}/docs/${relative}${hash}`;
	}
	return to;
}

// VitePress renders links on its own, so a core rule rewrites the link
// targets before rendering.
function repoOnlyLinks(md: Markdown): void {
	md.core.ruler.push("repo-only-links", (state) => {
		const env = state.env as MarkdownEnv & { path?: string };
		const pagePath = env.path ?? "";
		// Link tokens sit inside the children of inline tokens.
		const inline = state.tokens.flatMap((token) => token.children ?? []);
		for (const token of inline) {
			if (token.type !== "link_open") {
				continue;
			}
			const raw = token.attrGet("href");
			if (raw === null) {
				continue;
			}
			const rewritten = rewriteLink(raw, pagePath);
			if (rewritten !== raw) {
				token.attrSet("href", rewritten);
			}
		}
	});
}

function pageTitle(file: string): string {
	const text = readFileSync(join(srcDir, file), "utf8");
	const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const inFrontmatter = frontmatter?.[1].match(/^title:\s*(.+)$/m)?.[1];
	const heading = text.match(/^# +(.+)$/m)?.[1];
	return (inFrontmatter ?? heading ?? file).trim().replace(/^["']|["']$/g, "");
}

function markdownFiles(dir: string): string[] {
	return readdirSync(join(srcDir, dir), { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));
}

// The group order the sidebar shows: the guides in the order an operator
// reads them, the contributor Development pages after, and the ADRs last. A
// published folder that is not named here still shows: it appends after the
// named groups, in name order, so a new page or a new guide never requires a
// config edit.
const GROUP_ORDER: { folder: string; text: string }[] = [
	{ folder: "getting-started", text: "Getting Started" },
	{ folder: "operation", text: "Operation" },
	{ folder: "work-flow", text: "Work flow" },
	{ folder: "configuration", text: "Configuration" },
	{ folder: "development", text: "Development" },
	{ folder: "adr", text: "ADR" },
];

// The page order inside a group, in the order an operator reads them. A group
// the list does not name keeps the plain alphabetical order, and a page a
// named list omits still shows: it appends after the named pages, in name
// order, so a new page never requires a config edit.
const PAGE_ORDER: Record<string, string[]> = {
	"getting-started": ["prerequisites.md", "first-launch.md", "minimal-config.md"],
	operation: ["main-view.md", "consultation.md", "modals.md", "live-view.md"],
	"work-flow": ["handoffs.md", "completion.md"],
	development: ["commands.md", "shared-controls.md", "labels.md"],
};

function orderPages(folder: string, files: string[]): string[] {
	const wanted = PAGE_ORDER[folder] ?? [];
	return [
		...wanted.filter((name) => files.includes(name)),
		...files.filter((name) => !wanted.includes(name)),
	];
}

function sidebar(): DefaultTheme.Sidebar {
	const groups: DefaultTheme.SidebarGroup[] = [];
	const folders = readdirSync(srcDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() && !entry.name.startsWith(".") && !EXCLUDED.includes(entry.name),
		)
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));
	const groupOf = (folder: string): DefaultTheme.SidebarGroup => {
		const named = GROUP_ORDER.find((entry) => entry.folder === folder);
		// A folder the order does not name keeps the plain rule: an
		// all-lowercase name is an acronym, shown uppercased.
		const text = named?.text ?? (/^[a-z]+$/.test(folder) ? folder.toUpperCase() : folder);
		// The ADR group shows one landing item, not one entry per ADR: the
		// index lists every ADR, so the sidebar stays compact.
		const all = folder === "adr" ? ["index.md"] : markdownFiles(folder);
		const files = orderPages(folder, all);
		return {
			text,
			collapsible: true,
			items: files.map((name) => ({
				text: pageTitle(join(folder, name)),
				link: `/${folder}/${name}`,
			})),
		};
	};
	for (const named of GROUP_ORDER) {
		if (folders.includes(named.folder)) groups.push(groupOf(named.folder));
	}
	for (const folder of folders) {
		if (GROUP_ORDER.some((named) => named.folder === folder)) continue;
		groups.push(groupOf(folder));
	}
	return groups;
}

export default defineConfig({
	base: "/my-little-software-factory/",
	title: "My Little Software Factory",
	description:
		"Documentation for my little software factory: architecture decisions, standards, and guides.",
	srcExclude: [...EXCLUDED.map((folder) => `${folder}/**`), "**/.*/**"],
	// No dead-link exemptions. The repo-only-links markdown rule rewrites
	// every repository-only target (an excluded folder, or a file outside the
	// docs folder) to an external repository URL before VitePress checks
	// links, so the check never sees them. Every internal link that does not
	// resolve to a built page - in any relative or absolute shape - fails the
	// build.
	markdown: {
		config: (md) => {
			repoOnlyLinks(md as Markdown);
		},
	},
	themeConfig: {
		sidebar: sidebar(),
	},
});
