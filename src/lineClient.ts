import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import {
	Client,
	loginWithAuthToken,
	loginWithQR,
} from "@evex/linejs";
import { BaseClient } from "@evex/linejs/base";
import { FileStorage } from "@evex/linejs/storage";
import { appConfig, getPasswordCredentials } from "./config.js";

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

export async function createLineClient(): Promise<Client> {
	fs.mkdirSync(path.dirname(appConfig.storageFile), { recursive: true });

	const storage = new FileStorage(appConfig.storageFile);
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

	let client: Client;
	if (appConfig.forceLogin) {
		console.log("[line] LINE_FORCE_LOGIN=true; skipping stored auth token for this login");
	}
	if (!appConfig.forceLogin && envToken) {
		console.log("[line] logging in with LINE_AUTH_TOKEN");
		client = await loginWithAuthToken(envToken, init);
	} else if (!appConfig.forceLogin && typeof storedToken === "string" && storedToken.trim()) {
		console.log("[line] logging in with stored auth token");
		client = await loginWithAuthToken(storedToken, init);
	} else if (appConfig.loginMethod === "password") {
		const credentials = getPasswordCredentials();
		console.log("[line] logging in with email/password");
		console.log(`[line] password E2EE login: ${appConfig.e2eeLogin ? "enabled" : "disabled"}`);
		if (appConfig.forceLogin && appConfig.e2eeLogin) {
			await storage.delete(`cert:${credentials.email}`);
			console.log("[line] cleared stored password login certificate for E2EE re-login");
		}
		const base = new BaseClient(init);
		base.on("pincall", (pin) => {
			console.log(`[line] enter this pincode in LINE app: ${pin}`);
		});
		base.on("update:authtoken", saveToken);
		await base.loginProcess.withPassword({
			...credentials,
			v3: false,
			e2ee: appConfig.e2eeLogin,
		});
		await base.loginProcess.ready();
		client = new Client(base);
	} else {
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

	return client;
}
