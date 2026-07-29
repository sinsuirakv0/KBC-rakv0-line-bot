export type LineErrorKind =
	| "http-gone"
	| "timeout"
	| "auth-expired"
	| "auth-invalid"
	| "account-restricted"
	| "rate-limited"
	| "unsupported"
	| "transient"
	| "unknown";

export interface LineErrorClassification {
	kind: LineErrorKind;
	detail: string;
	authRelated: boolean;
	permanent: boolean;
}

export interface LoginRetryDecision extends LineErrorClassification {
	attempt: number;
	delayMs: number;
}

function serializeError(error: unknown): string {
	const base = error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
	try {
		const json = JSON.stringify(error);
		return json && json !== "{}" ? `${base} ${json}` : base;
	} catch {
		return base;
	}
}

export function compactLineError(error: unknown, maxLength = 360): string {
	return serializeError(error).replace(/\s+/g, " ").slice(0, maxLength);
}

export function classifyLineError(error: unknown): LineErrorClassification {
	const detail = compactLineError(error);
	if (/status=410\b|HTTP\s*410\b/i.test(detail)) {
		return { kind: "http-gone", detail, authRelated: false, permanent: false };
	}
	if (/EXCESSIVE_ACCESS|TOO_MANY_REQUESTS?|RATE.?LIMIT|status=429\b|HTTP\s*429\b/i.test(detail)) {
		return { kind: "rate-limited", detail, authRelated: false, permanent: false };
	}
	if (/suspended user|ACCOUNT_SUSPENDED|ACCOUNT_RESTRICTED/i.test(detail)) {
		return { kind: "account-restricted", detail, authRelated: true, permanent: true };
	}
	if (/INVALID_IDENTITY_CREDENTIAL|INVALID_AUTH(?:_TOKEN)?|AUTHENTICATION_FAILED/i.test(detail)) {
		return { kind: "auth-invalid", detail, authRelated: true, permanent: true };
	}
	if (
		/NOT_AUTHORIZED_DEVICE/i.test(detail) &&
		/\bEXPIRED\b|V3_TOKEN_CLIENT_LOGGED_OUT/i.test(detail)
	) {
		return { kind: "auth-expired", detail, authRelated: true, permanent: false };
	}
	if (/NOT_AUTHORIZED|AUTHENTICATION_DIVESTED|EXPIRED_AUTH/i.test(detail)) {
		return { kind: "auth-expired", detail, authRelated: true, permanent: false };
	}
	if (/API method not capable|NOT_IMPLEMENTED|Not yet implemented|UNSUPPORTED/i.test(detail)) {
		return { kind: "unsupported", detail, authRelated: false, permanent: true };
	}
	if (/timeout|timed out|aborted due to timeout|AbortError/i.test(detail)) {
		return { kind: "timeout", detail, authRelated: false, permanent: false };
	}
	if (
		/ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up|status=5\d\d\b|HTTP\s*5\d\d\b/i.test(detail)
	) {
		return { kind: "transient", detail, authRelated: false, permanent: false };
	}
	return { kind: "unknown", detail, authRelated: false, permanent: false };
}

export function isAuthenticationLineError(error: unknown): boolean {
	return classifyLineError(error).authRelated;
}

export function isExpiredAuthenticationLineError(error: unknown): boolean {
	return classifyLineError(error).kind === "auth-expired";
}

export function isUnsupportedLineError(error: unknown): boolean {
	return classifyLineError(error).kind === "unsupported";
}

export class LoginRetryPolicy {
	private attempt = 0;

	constructor(
		private readonly baseDelayMs: number,
		private readonly maxTransientDelayMs: number,
		private readonly invalidCredentialDelayMs: number,
		private readonly restrictedAccountDelayMs: number,
		private readonly rateLimitDelayMs: number,
		private readonly random: () => number = Math.random,
	) {}

	reset(): void {
		this.attempt = 0;
	}

	next(error: unknown): LoginRetryDecision {
		const classification = classifyLineError(error);
		this.attempt += 1;
		const exponential = Math.min(
			this.maxTransientDelayMs,
			this.baseDelayMs * (2 ** Math.min(6, this.attempt - 1)),
		);
		let base = exponential;
		if (classification.kind === "auth-invalid") base = this.invalidCredentialDelayMs;
		if (classification.kind === "account-restricted") base = this.restrictedAccountDelayMs;
		if (classification.kind === "rate-limited") base = this.rateLimitDelayMs;
		const jitter = 0.9 + Math.max(0, Math.min(1, this.random())) * 0.2;
		return {
			...classification,
			attempt: this.attempt,
			delayMs: Math.max(this.baseDelayMs, Math.round(base * jitter)),
		};
	}
}
