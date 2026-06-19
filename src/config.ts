import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();

export type LoginMethod = "qr" | "password" | "token";

function boolEnv(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined || value === "") return fallback;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

function loginMethod(): LoginMethod {
	const value = process.env.LINE_LOGIN_METHOD?.toLowerCase() || "qr";
	if (value === "qr" || value === "password" || value === "token") return value;
	throw new Error(`Invalid LINE_LOGIN_METHOD: ${value}`);
}

export const appConfig = {
	loginMethod: loginMethod(),
	email: process.env.LINE_EMAIL || "",
	password: process.env.LINE_PASSWORD || "",
	authToken: process.env.LINE_AUTH_TOKEN || "",
	device: process.env.LINE_DEVICE || "DESKTOPWIN",
	storageFile: path.resolve(process.env.LINE_STORAGE_FILE || "./storage/storage.json"),
	forceLogin: boolEnv("LINE_FORCE_LOGIN", false),
	e2eeLogin: boolEnv("LINE_E2EE_LOGIN", true),
	commandPrefix: process.env.COMMAND_PREFIX || "!",
	enableTalk: boolEnv("ENABLE_TALK", true),
	enableSquare: boolEnv("ENABLE_SQUARE", true),
};

export function getPasswordCredentials(): { email: string; password: string } {
	return {
		email: requiredEnv("LINE_EMAIL"),
		password: requiredEnv("LINE_PASSWORD"),
	};
}
