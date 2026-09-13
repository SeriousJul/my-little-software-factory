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
type PushRule = (state: { tokens: BlockToken[]; env: Record<string, unknown> }) => void;
type Markdown = {
	core: { ruler: { push(name: string, fn: PushRule): void } };
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
function rewriteLink(to: string, pagePath: string): string {
	if (to.startsWith("#") || to.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(to)) {
		return to;
	}
	const separator = to.indexOf("#");
	const hash = separator >= 0 ? to.slice(separator) : "";
	const target = separator >= 0 ? to.slice(0, separator) : to;
	const resolved = posix.normalize(posix.join(posix.dirname(pagePath), target));
	const relative = posix.relative(srcDirPosix, resolved);
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
function repoOnlyLinks() {
	return (md: Markdown) => {
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
	};
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

// The sidebar is generated from the folder structure at build time: the
// top-level pages form the Standards group, and every published folder forms
// a group of its own, in name order. Adding or moving a page never requires a
// config edit.
function sidebar(): DefaultTheme.Sidebar {
	const groups: DefaultTheme.SidebarGroup[] = [];
	const standards = markdownFiles("").filter((name) => name !== "index.md");
	if (standards.length > 0) {
		groups.push({
			text: "Standards",
			collapsible: true,
			items: standards.map((name) => ({ text: pageTitle(name), link: `/${name}` })),
		});
	}
	const folders = readdirSync(srcDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() && !entry.name.startsWith(".") && !EXCLUDED.includes(entry.name),
		)
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));
	for (const folder of folders) {
		// An all-lowercase folder name is an acronym; show it uppercased.
		const text = /^[a-z]+$/.test(folder) ? folder.toUpperCase() : folder;
		groups.push({
			text,
			collapsible: true,
			items: markdownFiles(folder).map((name) => ({
				text: pageTitle(join(folder, name)),
				link: `/${folder}/${name}`,
			})),
		});
	}
	return groups;
}

export default defineConfig({
	base: "/my-little-software-factory/",
	title: "My Little Software Factory",
	description:
		"Documentation for my little software factory: architecture decisions, standards, and guides.",
	srcExclude: [...EXCLUDED.map((folder) => `${folder}/**`), "**/.*/**"],
	// Links from published pages into repository-only content are rewritten to
	// the repository by the repo-only-links markdown rule. The dead-link check
	// still sees the raw link, so exactly those targets are exempt: a link
	// into an excluded folder, or a link that resolves outside the docs
	// folder. Every other broken internal link still fails the build.
	ignoreDeadLinks: [
		(raw) => {
			const url = raw.replace(/^\.\//, "");
			return EXCLUDED.includes(url.split("/")[0]) || url.startsWith("..");
		},
	],
	markdown: {
		config: (md) => {
			md.use(repoOnlyLinks() as unknown as Parameters<typeof md.use>[0]);
		},
	},
	themeConfig: {
		sidebar: sidebar(),
	},
});
