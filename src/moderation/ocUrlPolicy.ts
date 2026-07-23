export type OcUrlRuleScope = "exact" | "path" | "prefix" | "domain";
export type OcUrlBlockedComponent = "scheme" | "domain" | "path" | "parameter";

export interface ParsedOcUrl {
	original: string;
	scheme: string;
	hostname: string;
	port: string;
	pathname: string;
	search: string;
	hash: string;
	href: string;
}

export interface OcUrlAllowRule {
	id: string;
	scope: OcUrlRuleScope;
	scheme: string;
	hostname: string;
	port: string;
	pathname?: string;
	search?: string;
	hash?: string;
	sourceUrl: string;
	createdAt: string;
	createdBy: string;
}

const URL_PATTERN =
	/(?:[a-z][a-z\d+.-]{1,31}:\/\/|www\.)[^\s<>"'`]+|(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}(?::\d{2,5})?(?:\/[^\s<>"'`]*)?/giu;
const TRAILING_PUNCTUATION = /[.,;:!?。、，；：！？）」』】〉》\]}>]+$/u;
const RULE_SCOPES = new Set<OcUrlRuleScope>(["exact", "path", "prefix", "domain"]);

function cleanCandidate(value: string): string {
	return value.replace(TRAILING_PUNCTUATION, "");
}

function normalizePathname(value: string): string {
	if (!value) return "/";
	return value.startsWith("/") ? value : `/${value}`;
}

function ruleKey(rule: Pick<
	OcUrlAllowRule,
	"scope" | "scheme" | "hostname" | "port" | "pathname" | "search" | "hash"
>): string {
	return [
		rule.scope,
		rule.scheme,
		rule.hostname,
		rule.port,
		rule.pathname ?? "",
		rule.search ?? "",
		rule.hash ?? "",
	].join("\u0000");
}

function sameOrigin(url: ParsedOcUrl, rule: OcUrlAllowRule): boolean {
	return url.scheme === rule.scheme &&
		url.hostname === rule.hostname &&
		url.port === rule.port;
}

function pathPrefixMatches(pathname: string, prefix: string): boolean {
	if (prefix === "/") return true;
	const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
	return pathname === normalizedPrefix || pathname.startsWith(`${normalizedPrefix}/`);
}

export function parseOcUrl(value: string): ParsedOcUrl | undefined {
	const original = cleanCandidate(value.trim());
	if (!original) return undefined;
	const withScheme = /^www\./i.test(original) || !/^[a-z][a-z\d+.-]*:\/\//i.test(original)
		? `https://${original}`
		: original;
	try {
		const parsed = new URL(withScheme);
		if (!parsed.hostname) return undefined;
		const scheme = parsed.protocol.slice(0, -1).toLowerCase();
		const hostname = parsed.hostname.toLowerCase();
		const port = parsed.port;
		const pathname = normalizePathname(parsed.pathname);
		const href = `${scheme}://${hostname}${port ? `:${port}` : ""}${pathname}${parsed.search}${parsed.hash}`;
		return {
			original,
			scheme,
			hostname,
			port,
			pathname,
			search: parsed.search,
			hash: parsed.hash,
			href,
		};
	} catch {
		return undefined;
	}
}

export function extractOcUrls(text: string | undefined): ParsedOcUrl[] {
	if (!text) return [];
	const found = new Map<string, ParsedOcUrl>();
	const normalized = text.normalize("NFKC");
	for (const match of normalized.matchAll(URL_PATTERN)) {
		const previous = match.index > 0 ? normalized[match.index - 1] : "";
		if (previous && /[\p{L}\p{N}_@-]/u.test(previous)) continue;
		const parsed = parseOcUrl(match[0]);
		if (parsed && !found.has(parsed.href)) found.set(parsed.href, parsed);
	}
	return [...found.values()];
}

export function matchesOcUrlRule(url: ParsedOcUrl, rule: OcUrlAllowRule): boolean {
	if (!sameOrigin(url, rule)) return false;
	if (rule.scope === "domain") return true;
	const pathname = rule.pathname ?? "/";
	if (rule.scope === "prefix") return pathPrefixMatches(url.pathname, pathname);
	if (url.pathname !== pathname) return false;
	if (rule.scope === "path") return true;
	return url.search === (rule.search ?? "") && url.hash === (rule.hash ?? "");
}

export function isOcUrlAllowed(url: ParsedOcUrl, rules: OcUrlAllowRule[]): boolean {
	if (url.scheme !== "https") return false;
	return rules.some((rule) => matchesOcUrlRule(url, rule));
}

export function blockedOcUrlComponent(
	url: ParsedOcUrl,
	rules: OcUrlAllowRule[],
): OcUrlBlockedComponent {
	if (url.scheme !== "https") return "scheme";
	const sameDomain = rules.filter((rule) =>
		rule.hostname === url.hostname && rule.port === url.port
	);
	if (sameDomain.length === 0) return "domain";
	const sameScheme = sameDomain.filter((rule) => rule.scheme === url.scheme);
	if (sameScheme.length === 0) return "scheme";
	const samePath = sameScheme.some((rule) =>
		rule.pathname === url.pathname ||
		(rule.scope === "prefix" && pathPrefixMatches(url.pathname, rule.pathname ?? "/"))
	);
	return samePath ? "parameter" : "path";
}

export function createOcUrlAllowRule(
	url: ParsedOcUrl,
	scope: OcUrlRuleScope,
	createdBy: string,
): OcUrlAllowRule {
	if (url.scheme !== "https") {
		throw new Error("Only HTTPS URLs can be added to the allowlist");
	}
	const rule: OcUrlAllowRule = {
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		scope,
		scheme: url.scheme,
		hostname: url.hostname,
		port: url.port,
		sourceUrl: url.href,
		createdAt: new Date().toISOString(),
		createdBy,
	};
	if (scope !== "domain") rule.pathname = url.pathname;
	if (scope === "exact") {
		rule.search = url.search;
		rule.hash = url.hash;
	}
	return rule;
}

export function parseOcUrlAllowRules(value: unknown): OcUrlAllowRule[] {
	if (!Array.isArray(value)) return [];
	const rules = new Map<string, OcUrlAllowRule>();
	for (const entry of value) {
		const item = entry as Partial<OcUrlAllowRule>;
		if (
			typeof item.id !== "string" ||
			typeof item.scope !== "string" ||
			!RULE_SCOPES.has(item.scope as OcUrlRuleScope) ||
			typeof item.scheme !== "string" ||
			item.scheme.toLowerCase() !== "https" ||
			typeof item.hostname !== "string" ||
			!item.hostname ||
			typeof item.createdAt !== "string" ||
			typeof item.createdBy !== "string"
		) continue;
		const rule: OcUrlAllowRule = {
			id: item.id,
			scope: item.scope as OcUrlRuleScope,
			scheme: item.scheme.toLowerCase(),
			hostname: item.hostname.toLowerCase(),
			port: typeof item.port === "string" ? item.port : "",
			pathname: typeof item.pathname === "string" ? normalizePathname(item.pathname) : undefined,
			search: typeof item.search === "string" ? item.search : undefined,
			hash: typeof item.hash === "string" ? item.hash : undefined,
			sourceUrl: typeof item.sourceUrl === "string" ? item.sourceUrl : "",
			createdAt: item.createdAt,
			createdBy: item.createdBy,
		};
		rules.set(ruleKey(rule), rule);
	}
	return [...rules.values()];
}

export function sameOcUrlRule(left: OcUrlAllowRule, right: OcUrlAllowRule): boolean {
	return ruleKey(left) === ruleKey(right);
}

export function ocUrlRuleTarget(rule: OcUrlAllowRule): string {
	const origin = `${rule.scheme}://${rule.hostname}${rule.port ? `:${rule.port}` : ""}`;
	if (rule.scope === "domain") return origin;
	const path = rule.pathname ?? "/";
	if (rule.scope === "prefix") return `${origin}${path}${path.endsWith("/") ? "" : "/"}*`;
	if (rule.scope === "path") return `${origin}${path}?*`;
	return `${origin}${path}${rule.search ?? ""}${rule.hash ?? ""}`;
}
