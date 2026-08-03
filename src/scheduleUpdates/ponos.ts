import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { appConfig } from "../config.js";
import type { EventTsvTextByType, EventTsvType } from "./preview.js";

const AUTH_USER_AGENT = "Dalvik/2.1.0 (Linux; Android 9; SM-G955F Build/N2G48B)";
const EVENT_BASE_URL = "https://nyanko-events.ponosgames.com/battlecats_production";
const JWT_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
const JWT_EXPIRY_SAFETY_MS = 5 * 60 * 1_000;
const EVENT_TYPES = ["gatya", "sale", "item"] as const satisfies readonly EventTsvType[];

interface JwtCache {
	jwt: string;
	createdAt: string;
	expiresAt?: string;
}

class PonosHttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
		this.name = "PonosHttpError";
	}
}

let memoryCache: JwtCache | undefined;
let pendingJwt: Promise<string> | undefined;

function generateSignature(inquiryCode: string, dataString: string): string {
	const randomData = crypto.randomBytes(32).toString("hex");
	const key = inquiryCode + randomData;
	return randomData + crypto.createHmac("sha256", key).update(dataString).digest("hex");
}

function authHeaders(inquiryCode: string, dataString: string): Record<string, string> {
	return {
		"content-type": "application/json",
		"nyanko-signature": generateSignature(inquiryCode, dataString),
		"nyanko-timestamp": Math.floor(Date.now() / 1_000).toString(),
		"nyanko-signature-version": "1",
		"nyanko-signature-algorithm": "HMACSHA256",
		"user-agent": AUTH_USER_AGENT,
	};
}

async function requestJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new PonosHttpError(response.status, `PONOS API HTTP ${response.status}`);
	return await response.json() as Record<string, unknown>;
}

async function createInquiryCode(): Promise<string> {
	const body = await requestJson("https://nyanko-backups.ponosgames.com/?action=createAccount&referenceId=");
	if (typeof body.accountId !== "string" || !body.accountId) {
		throw new Error("PONOS inquiry code was not returned");
	}
	return body.accountId;
}

async function createPassword(inquiryCode: string): Promise<string> {
	const dataString = JSON.stringify({
		accountCode: inquiryCode,
		accountCreatedAt: Math.floor(Date.now() / 1_000).toString(),
		nonce: crypto.randomBytes(16).toString("hex"),
	});
	const body = await requestJson("https://nyanko-auth.ponosgames.com/v1/users", {
		method: "POST",
		headers: authHeaders(inquiryCode, dataString),
		body: dataString,
	});
	const payload = body.payload as Record<string, unknown> | undefined;
	if (typeof payload?.password !== "string" || !payload.password) {
		throw new Error("PONOS password was not returned");
	}
	return payload.password;
}

async function createToken(inquiryCode: string, password: string): Promise<string> {
	const dataString = JSON.stringify({
		clientInfo: {
			client: { countryCode: "ja", version: "999999" },
			device: { model: "ONEPLUS A3010" },
			os: { type: "android", version: "7.1.1" },
		},
		password,
		accountCode: inquiryCode,
		nonce: crypto.randomBytes(16).toString("hex"),
	});
	const body = await requestJson("https://nyanko-auth.ponosgames.com/v1/tokens", {
		method: "POST",
		headers: authHeaders(inquiryCode, dataString),
		body: dataString,
	});
	const payload = body.payload as Record<string, unknown> | undefined;
	if (typeof payload?.token !== "string" || !payload.token) {
		throw new Error("PONOS JWT was not returned");
	}
	return payload.token;
}

function parseJwtExpiry(jwt: string): number | undefined {
	try {
		const encoded = jwt.split(".")[1];
		if (!encoded) return undefined;
		const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
		const payload = JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as { exp?: unknown };
		return Number.isFinite(payload.exp) ? Number(payload.exp) * 1_000 : undefined;
	} catch {
		return undefined;
	}
}

function isUsableCache(cache: JwtCache | undefined): cache is JwtCache {
	if (!cache?.jwt || !cache.createdAt) return false;
	const now = Date.now();
	const createdAt = Date.parse(cache.createdAt);
	if (!Number.isFinite(createdAt) || now - createdAt < 0 || now - createdAt >= JWT_CACHE_TTL_MS) return false;
	const expiresAt = Date.parse(cache.expiresAt ?? "") || parseJwtExpiry(cache.jwt);
	return !expiresAt || expiresAt - now > JWT_EXPIRY_SAFETY_MS;
}

async function readCache(): Promise<JwtCache | undefined> {
	if (isUsableCache(memoryCache)) return memoryCache;
	try {
		const value = JSON.parse(
			(await fs.readFile(appConfig.ponosJwtCacheFile, "utf8")).replace(/^\uFEFF/, ""),
		) as JwtCache;
		if (!isUsableCache(value)) return undefined;
		memoryCache = value;
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn("[schedule-update] PONOS JWT cache ignored", error);
		}
		return undefined;
	}
}

async function saveCache(jwt: string): Promise<void> {
	const expiresAt = parseJwtExpiry(jwt);
	const value: JwtCache = {
		jwt,
		createdAt: new Date().toISOString(),
		...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
	};
	await fs.mkdir(path.dirname(appConfig.ponosJwtCacheFile), { recursive: true });
	const temporary = `${appConfig.ponosJwtCacheFile}.tmp`;
	await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await fs.rename(temporary, appConfig.ponosJwtCacheFile);
	memoryCache = value;
}

async function issueJwt(): Promise<string> {
	const inquiryCode = await createInquiryCode();
	const password = await createPassword(inquiryCode);
	const jwt = await createToken(inquiryCode, password);
	await saveCache(jwt);
	return jwt;
}

async function getJwt(forceRefresh = false): Promise<string> {
	if (!forceRefresh) {
		const cached = await readCache();
		if (cached) return cached.jwt;
	}
	if (!pendingJwt) {
		pendingJwt = issueJwt().finally(() => {
			pendingJwt = undefined;
		});
	}
	return pendingJwt;
}

async function fetchEventTsv(type: EventTsvType, jwt: string): Promise<string> {
	const url = new URL(`${EVENT_BASE_URL}/${type}.tsv`);
	url.searchParams.set("jwt", jwt);
	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new PonosHttpError(response.status, `${type}.tsv HTTP ${response.status}`);
	return response.text();
}

async function fetchWithJwt(jwt: string): Promise<EventTsvTextByType> {
	const entries = await Promise.all(EVENT_TYPES.map(async (type) => [
		type,
		await fetchEventTsv(type, jwt),
	] as const));
	return Object.fromEntries(entries) as EventTsvTextByType;
}

export async function fetchCurrentEventTsv(): Promise<EventTsvTextByType> {
	const jwt = await getJwt();
	try {
		return await fetchWithJwt(jwt);
	} catch (error) {
		if (!(error instanceof PonosHttpError) || (error.status !== 401 && error.status !== 403)) throw error;
		memoryCache = undefined;
		return fetchWithJwt(await getJwt(true));
	}
}
