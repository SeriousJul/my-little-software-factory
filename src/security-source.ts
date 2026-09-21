/**
 * The built-in GitHub security ticket sources (issue #73).
 *
 * The three kinds read the repository security feeds as `gh api` REST calls,
 * one call set per configured repository. Every read goes through the
 * command runner, authentication travels through the shared GitHub
 * authenticator, and a failed request on any repository fails the whole
 * snapshot so the source goes stale under the existing semantics.
 *
 * Every read is an explicit GET with `--paginate`: without the method, `gh
 * api` posts the form fields and the list endpoints answer 404, and the
 * page-number parameter the alert and advisory endpoints reject is replaced
 * by `gh` following GitHub's own pagination, one merged JSON array per feed.
 */
import type { TicketSourceConfig } from "./config.ts";
import type { FetchedTicket, RepositoryRef } from "./domain/ticket.ts";
import { type CommandOptions, type CommandRunner, commandFailureText } from "./runner.ts";
import { type FetchOutcome, GhAuthenticator, type TicketSource } from "./ticket-source.ts";

/** The config kind of one security feed source. */
export type SecuritySourceKind =
	| "github-security-advisories"
	| "github-dependabot-alerts"
	| "github-secret-scanning-alerts";

/** The singular source kind the ticket carries, sibling of `github-issue`. */
const TICKET_SOURCE_KIND: Record<SecuritySourceKind, string> = {
	"github-security-advisories": "github-security-advisory",
	"github-dependabot-alerts": "github-dependabot-alert",
	"github-secret-scanning-alerts": "github-secret-scanning-alert",
};

/** The advisory states the advisory feed lists: open work, not closed items. */
const ADVISORY_WORKING_STATES = ["triage", "draft", "published"] as const;

/**
 * The feature-off answer GitHub gives per repository. A repository can switch
 * the feed's feature off, and no refresh ever changes it: the read skips the
 * repository with a warning instead of failing the snapshot, and a real
 * failure on any repository still fails it.
 */
const FEATURE_DISABLED: Partial<Record<SecuritySourceKind, { marker: string; prefix: string }>> = {
	"github-dependabot-alerts": {
		marker: "Dependabot alerts are disabled for this repository",
		prefix: "Dependabot alerts are disabled for",
	},
	"github-secret-scanning-alerts": {
		marker: "Secret scanning is disabled on this repository",
		prefix: "Secret scanning is disabled for",
	},
};

/** The page size one `--paginate` call reads. */
const PAGE_SIZE = 100;

interface SecurityRequest {
	/** The configured repository (owner/name) the endpoint was asked for. */
	repository: string;
	/** The REST endpoint path, relative to the API root. */
	endpoint: string;
	/** The state the feed lists for this repository. */
	state: string;
}

export class GitHubSecurityTicketSource implements TicketSource {
	readonly name: string;
	readonly kind: SecuritySourceKind;
	readonly refreshIntervalMs: number;
	private readonly config: TicketSourceConfig;
	private readonly runner: CommandRunner;
	private readonly authenticator: GhAuthenticator;

	constructor(config: TicketSourceConfig, runner: CommandRunner, environment: NodeJS.ProcessEnv) {
		this.config = config;
		this.runner = runner;
		this.authenticator = new GhAuthenticator(config.host, config.auth, runner, environment);
		this.name = config.name;
		this.kind = config.kind as SecuritySourceKind;
		this.refreshIntervalMs = config.refreshIntervalSeconds * 1000;
	}

	async fetch(): Promise<FetchOutcome> {
		try {
			const authentication = await this.authenticator.resolve();
			if (!authentication.ok) return { status: "failed", reason: authentication.reason };
			const tickets: FetchedTicket[] = [];
			const warnings: string[] = [];
			for (const request of this.requests()) {
				const items = await this.readFeed(request, authentication.options);
				if (!items.ok) {
					const disabled = FEATURE_DISABLED[this.kind];
					if (disabled !== undefined && items.reason.includes(disabled.marker)) {
						// The repository switched the feed's feature off: skip it.
						warnings.push(`${disabled.prefix} ${request.repository}`);
						continue;
					}
					return { status: "failed", reason: items.reason };
				}
				for (const item of items.items) {
					const normalized = normalizeSecurityItem(
						this.kind,
						item,
						this.config,
						request.repository,
					);
					if (!normalized.ok) return { status: "failed", reason: normalized.reason };
					tickets.push(normalized.ticket);
				}
			}
			return {
				status: "success",
				fetchedAt: new Date().toISOString(),
				tickets,
				...(warnings.length === 0 ? {} : { warnings }),
			};
		} catch (error) {
			// A source bug must not terminate the control plane.
			return {
				status: "failed",
				reason: `unexpected GitHub security source failure: ${readableError(error)}`,
			};
		}
	}

	/**
	 * The call set of one refresh: advisories read one request per working
	 * state because the state filter takes a single value, and the alert
	 * feeds read one request each with `state=open`.
	 */
	private requests(): SecurityRequest[] {
		if (this.kind === "github-security-advisories") {
			const requests: SecurityRequest[] = [];
			for (const repository of this.config.repositories) {
				for (const state of ADVISORY_WORKING_STATES) {
					requests.push({
						repository,
						endpoint: `repos/${repository}/security-advisories`,
						state,
					});
				}
			}
			return requests;
		}
		const endpoint =
			this.kind === "github-dependabot-alerts" ? "dependabot/alerts" : "secret-scanning/alerts";
		return this.config.repositories.map((repository) => ({
			repository,
			endpoint: `repos/${repository}/${endpoint}`,
			state: "open",
		}));
	}

	/**
	 * One endpoint read to completion. `gh api --paginate` follows GitHub's
	 * pagination for the endpoint - page-number or cursor - and prints the
	 * pages as one JSON array, so one call returns the whole feed. The
	 * explicit GET is load-bearing: with form fields and no method, `gh api`
	 * posts to the endpoint, and the list endpoints answer 404.
	 */
	private async readFeed(
		request: SecurityRequest,
		options: CommandOptions,
	): Promise<{ ok: true; items: unknown[] } | { ok: false; reason: string }> {
		const args = [
			"api",
			request.endpoint,
			"--hostname",
			this.config.host,
			"--method",
			"GET",
			"-f",
			`state=${request.state}`,
			"-f",
			`per_page=${PAGE_SIZE}`,
			"--paginate",
		];
		const result = await this.runner.run("gh", args, options);
		if (result.code !== 0)
			return { ok: false, reason: `GitHub request failed: ${commandFailureText(result)}` };
		const parsed = parseSecurityPage(result.stdout);
		if (!parsed.ok) return { ok: false, reason: parsed.reason };
		return { ok: true, items: parsed.items };
	}
}

/**
 * One REST page body: a JSON array. Command-runner noise before the JSON is
 * tolerated, exactly as the search page reader does.
 */
type SecurityPage = { ok: true; items: unknown[] } | { ok: false; reason: string };
function parseSecurityPage(text: string): SecurityPage {
	const json = text.slice(text.indexOf("["));
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return { ok: false, reason: "GitHub returned invalid JSON" };
	}
	if (!Array.isArray(raw)) return { ok: false, reason: "GitHub returned an unreadable list" };
	return { ok: true, items: raw };
}

/** The repository fact of one request: the configured repository read back. */
function repositoryOf(host: string, repository: string): RepositoryRef {
	const lower = repository.toLowerCase();
	return {
		identity: `${host.toLowerCase()}/${lower}`,
		displayName: repository,
		cloneUrl: `https://${host}/${repository}.git`,
	};
}

/**
 * One item of one feed, normalized into the fetched-ticket shape. A failure
 * is an unreadable item or an item outside the configured repositories.
 */
function normalizeSecurityItem(
	kind: SecuritySourceKind,
	item: unknown,
	config: TicketSourceConfig,
	repository: string,
): { ok: true; ticket: FetchedTicket } | { ok: false; reason: string } {
	const record = item as Record<string, unknown>;
	if (record === null || typeof record !== "object" || Array.isArray(record))
		return { ok: false, reason: `GitHub returned an unreadable ${TICKET_SOURCE_KIND[kind]} item` };
	if (kind === "github-security-advisories")
		return normalizeSecurityAdvisory(record, config, repository);
	if (kind === "github-dependabot-alerts")
		return normalizeDependabotAlert(record, config, repository);
	return normalizeSecretScanningAlert(record, config, repository);
}

function normalizeSecurityAdvisory(
	record: Record<string, unknown>,
	config: TicketSourceConfig,
	repository: string,
): { ok: true; ticket: FetchedTicket } | { ok: false; reason: string } {
	const ghsaId = stringOf(record.ghsa_id);
	const summary = stringOf(record.summary);
	const state = stringOf(record.state);
	const url = stringOf(record.html_url) ?? stringOf(record.url);
	const updatedAt =
		stringOf(record.updated_at) ?? stringOf(record.published_at) ?? stringOf(record.created_at);
	if (
		ghsaId === undefined ||
		summary === undefined ||
		state === undefined ||
		url === undefined ||
		updatedAt === undefined
	)
		return { ok: false, reason: "GitHub returned an unreadable security advisory" };
	const description = typeof record.description === "string" ? record.description : "";
	const severity = stringOf(record.severity);
	const components = advisoryComponentLines(record.vulnerabilities);
	return {
		ok: true,
		ticket: {
			identity: `github:${config.host.toLowerCase()}:${ghsaId}`,
			sourceKind: TICKET_SOURCE_KIND["github-security-advisories"],
			externalKey: ghsaId,
			sourceState: state.toLowerCase(),
			url,
			title: summary,
			description:
				components.length === 0
					? description
					: `${description}\n\nAffected components:\n${components.join("\n")}`,
			// ADR 0029: the severity is the ticket's single label, and no
			// severity means no label: the factory never invents a rank.
			labels: severity === undefined ? [] : [severity],
			externalUpdatedAt: updatedAt,
			repository: repositoryOf(config.host, repository),
			attributes: {},
		},
	};
}

/** The advisory's named vulnerable components, one line each. */
function advisoryComponentLines(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const lines: string[] = [];
	for (const entry of raw) {
		const record = entry as Record<string, unknown>;
		const packageInfo = record.package as Record<string, unknown> | undefined;
		const ecosystem = stringOf(packageInfo?.ecosystem);
		const name = stringOf(packageInfo?.name);
		if (ecosystem === undefined || name === undefined) continue;
		const range = stringOf(record.vulnerable_version_range) ?? "unknown range";
		const patched = stringOf(record.first_patched_version);
		lines.push(
			patched === undefined
				? `- ${ecosystem} ${name}: vulnerable ${range}`
				: `- ${ecosystem} ${name}: vulnerable ${range}, first patched ${patched}`,
		);
	}
	return lines;
}

function normalizeDependabotAlert(
	record: Record<string, unknown>,
	config: TicketSourceConfig,
	repository: string,
): { ok: true; ticket: FetchedTicket } | { ok: false; reason: string } {
	const number = record.number;
	const state = stringOf(record.state);
	const url = stringOf(record.html_url);
	const updatedAt = stringOf(record.updated_at) ?? stringOf(record.created_at);
	// The list endpoint does not always name the alert's repository, and an
	// item of one repository endpoint belongs to that repository, so the
	// requested repository is the fallback. A declared name outside the
	// configured list is a failed fetch, the same guard the issue and pull
	// request sources apply.
	const declared = stringOf((record.repository as Record<string, unknown> | undefined)?.full_name);
	const full_name = declared ?? repository;
	if (
		typeof number !== "number" ||
		state === undefined ||
		url === undefined ||
		updatedAt === undefined ||
		full_name === undefined
	)
		return { ok: false, reason: "GitHub returned an unreadable Dependabot alert" };
	if (
		declared !== undefined &&
		!config.repositories.some((name) => name.toLowerCase() === declared.toLowerCase())
	) {
		return {
			ok: false,
			reason: `GitHub returned a ticket outside configured repositories: ${declared}`,
		};
	}
	const advisory = (record.security_advisory ?? {}) as Record<string, unknown>;
	const vulnerability = (record.security_vulnerability ?? {}) as Record<string, unknown>;
	const packageInfo = (vulnerability.package ?? {}) as Record<string, unknown>;
	const cveId = stringOf(advisory.cve_id);
	const ghsaId = stringOf(advisory.ghsa_id);
	const id = cveId ?? ghsaId;
	const summary = stringOf(advisory.summary);
	const title =
		id === undefined ? (summary ?? "") : summary === undefined ? id : `${id}: ${summary}`;
	if (title === "") return { ok: false, reason: "GitHub returned an unreadable Dependabot alert" };
	const lines: string[] = [];
	const facts: Array<[string, unknown]> = [
		["Package", stringOf(packageInfo.name)],
		["Ecosystem", stringOf(packageInfo.ecosystem)],
		["Manifest", stringOf(record.manifest_path)],
		["Scope", stringOf(record.scope)],
		["Relationship", stringOf(record.relationship)],
		["Vulnerable range", stringOf(vulnerability.vulnerable_version_range)],
		["First patched version", stringOf(vulnerability.first_patched_version)],
	];
	for (const [label, value] of facts) if (value !== undefined) lines.push(`${label}: ${value}`);
	// The severity is the advisory's, with the embedded vulnerability's as
	// the fallback (ADR 0029).
	const severity = stringOf(advisory.severity) ?? stringOf(vulnerability.severity);
	if (severity !== undefined) lines.push(`Severity: ${severity}`);
	const cvssScore = (advisory.cvss as Record<string, unknown> | undefined)?.score;
	if (typeof cvssScore === "number") lines.push(`CVSS score: ${cvssScore}`);
	const advisoryDescription = typeof advisory.description === "string" ? advisory.description : "";
	const description =
		lines.length > 0
			? advisoryDescription === ""
				? lines.join("\n")
				: `${lines.join("\n")}\n\n${advisoryDescription}`
			: advisoryDescription;
	return {
		ok: true,
		ticket: {
			identity: `github:${config.host.toLowerCase()}:${full_name.toLowerCase()}:dependabot:${number}`,
			sourceKind: TICKET_SOURCE_KIND["github-dependabot-alerts"],
			externalKey: `#${number}`,
			sourceState: state.toLowerCase(),
			url,
			title,
			description,
			labels: severity === undefined ? [] : [severity],
			externalUpdatedAt: updatedAt,
			repository: repositoryOf(config.host, repository),
			attributes: {},
		},
	};
}

function normalizeSecretScanningAlert(
	record: Record<string, unknown>,
	config: TicketSourceConfig,
	repository: string,
): { ok: true; ticket: FetchedTicket } | { ok: false; reason: string } {
	const id = record.id;
	const number = record.number;
	const state = stringOf(record.state);
	const url = stringOf(record.html_url);
	// The secret scanning object can carry a null updated-at; the created-at
	// is the next-newer timestamp the source then lists.
	const updatedAt = stringOf(record.updated_at) ?? stringOf(record.created_at);
	const secretType = stringOf((record.secret_type as Record<string, unknown> | undefined)?.name);
	const location = (record.location ?? {}) as Record<string, unknown>;
	const file = stringOf(location.file);
	const startLine = location.start_line;
	const endLine = location.end_line;
	if (
		typeof id !== "number" ||
		typeof number !== "number" ||
		state === undefined ||
		url === undefined ||
		updatedAt === undefined ||
		secretType === undefined ||
		file === undefined
	)
		return { ok: false, reason: "GitHub returned an unreadable secret scanning alert" };
	const lines = [
		`Secret type: ${secretType}`,
		`File: ${file}`,
		...(typeof startLine === "number" && typeof endLine === "number"
			? [startLine === endLine ? `Lines: ${startLine}` : `Lines: ${startLine}-${endLine}`]
			: []),
	];
	// ADR 0029: an open secret alert is a live credential and always ranks
	// critical, whatever else the item carries.
	return {
		ok: true,
		ticket: {
			identity: `github:${config.host.toLowerCase()}:secret-scanning:${id}`,
			sourceKind: TICKET_SOURCE_KIND["github-secret-scanning-alerts"],
			externalKey: `#${number}`,
			sourceState: state.toLowerCase(),
			url,
			title: `Exposed ${secretType}`,
			description: lines.join("\n"),
			labels: ["critical"],
			externalUpdatedAt: updatedAt,
			repository: repositoryOf(config.host, repository),
			attributes: {},
		},
	};
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}
function readableError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
