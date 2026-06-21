import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import {
	Client,
	loginWithAuthToken,
	loginWithQR,
} from "@evex/linejs";
import { BaseClient } from "@evex/linejs/base";
import { appConfig, getPasswordCredentials } from "./config.js";
import type { SyncedLineStorage } from "./storage/lineStorage.js";

const STORAGE_AUTH_KEY = ".auth";

async function writeQrCode(url: string): Promise<void> {
	const logsDir = path.resolve("logs");
	fs.mkdirSync(logsDir, { recursive: true });
	const qrPath = path.join(logsDir, "line-login-qr.png");
	await QRCode.toFile(qrPath, url, { width: 420, margin: 2 });
	const terminalQr = await QRCode.toString(url, {
		type: "terminal",
		small: true,
	});
	console.log(terminalQr);
	console.log(`[line] QR image saved: ${qrPath}`);
}

export function isAuthenticationError(error: unknown): boolean {
	let detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	try {
		detail += ` ${JSON.stringify(error)}`;
	} catch { /* best-effort error inspection */ }
	return /NOT_AUTHORIZED|AUTHENTICATION_DIVESTED|INVALID_AUTH|EXPIRED_AUTH/i.test(detail);
}

export async function createLineClient(storage: SyncedLineStorage): Promise<Client> {
	const storedToken = await storage.get(STORAGE_AUTH_KEY);
	const envToken = appConfig.authToken.trim();

	const init = {
		device: appConfig.device as never,
		storage,
	};

	const saveToken = async (authToken: string) => {
		await storage.set(STORAGE_AUTH_KEY, authToken);
		console.log("[line] auth token updated and saved to FileStorage");
	};

	let client: Client | undefined;
	if (appConfig.forceLogin) {
		console.log("[line] LINE_FORCE_LOGIN=true; skipping stored auth token for this login");
	}
	if (!appConfig.forceLogin) {
		const candidates = [
			typeof storedToken === "string" && storedToken.trim()
				? { source: "stored auth token", token: storedToken.trim() }
				: null,
			envToken ? { source: "LINE_AUTH_TOKEN", token: envToken } : null,
		].filter((candidate): candidate is { source: string; token: string } => Boolean(candidate));
		const tried = new Set<string>();
		for (const candidate of candidates) {
			if (tried.has(candidate.token)) continue;
			tried.add(candidate.token);
			try {
				console.log(`[line] logging in with ${candidate.source}`);
				client = await loginWithAuthToken(candidate.token, init);
				break;
			} catch (error) {
				if (!isAuthenticationError(error)) throw error;
				console.warn(`[line] ${candidate.source} was rejected; falling back to a fresh login`);
			}
		}
	}

	const canUsePassword = Boolean(appConfig.email && appConfig.password);
	if (!client && (appConfig.loginMethod === "password" || canUsePassword)) {
		const credentials = getPasswordCredentials();
		console.log("[line] logging in with email/password");
		console.log(`[line] login PIN: ${appConfig.loginPin}`);
		console.log(`[line] password E2EE login: ${appConfig.e2eeLogin ? "enabled" : "disabled"}`);
		const base = new BaseClient(init);
		base.on("pincall", (pin) => {
			console.log(`[line] enter this pincode in LINE app: ${pin}`);
		});
		base.on("update:authtoken", saveToken);
		await base.loginProcess.withPassword({
			...credentials,
			v3: false,
			e2ee: appConfig.e2eeLogin,
			pincode: appConfig.loginPin,
		});
		await base.loginProcess.ready();
		client = new Client(base);
	} else if (!client) {
		console.log("[line] logging in with QR");
		client = await loginWithQR({
			async onReceiveQRUrl(url) {
				console.log(`[line] open this QR URL with the LINE account: ${url}`);
				await writeQrCode(url);
			},
			onPincodeRequest(pin) {
				console.log(`[line] enter this pincode in LINE app: ${pin}`);
			},
		}, init);
	}

	client.base.on("update:authtoken", saveToken);
	await saveToken(client.authToken);
	await storage.flushBackup();

	return client;
}
