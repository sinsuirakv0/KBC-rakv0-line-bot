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

function loginPin(): string {
	const value = process.env.LINE_LOGIN_PIN || "114514";
	if (!/^\d{6}$/.test(value)) throw new Error("LINE_LOGIN_PIN must be exactly 6 digits");
	return value;
}

function subscriptionsGithubPath(): string {
	const value = process.env.PUSH_SUBSCRIPTIONS_GITHUB_PATH || "subscriptions/push-subscriptions.json";
	// Migrate the path used by the first deployment to the folder layout.
	return value === "push-subscriptions.json" ? "subscriptions/push-subscriptions.json" : value;
}

export const appConfig = {
	loginMethod: loginMethod(),
	email: process.env.LINE_EMAIL || "",
	password: process.env.LINE_PASSWORD || "",
	authToken: process.env.LINE_AUTH_TOKEN || "",
	loginPin: loginPin(),
	device: process.env.LINE_DEVICE || "DESKTOPWIN",
	storageFile: path.resolve(process.env.LINE_STORAGE_FILE || "./storage/storage.json"),
	forceLogin: boolEnv("LINE_FORCE_LOGIN", false),
	e2eeLogin: boolEnv("LINE_E2EE_LOGIN", true),
	commandPrefix: process.env.COMMAND_PREFIX || "!",
	enableTalk: boolEnv("ENABLE_TALK", true),
	enableSquare: boolEnv("ENABLE_SQUARE", true),
	port: Number(process.env.PORT || process.env.EVENT_UPDATE_PORT || 3000),
	eventUpdateSecret: process.env.EVENT_UPDATE_SECRET || "",
	pushSubscriptionsFile: path.resolve(
		process.env.PUSH_SUBSCRIPTIONS_FILE || "./storage/push-subscriptions.json",
	),
	pushSubscriptionsGithubRepo: process.env.PUSH_SUBSCRIPTIONS_GITHUB_REPO || "",
	pushSubscriptionsGithubPath: subscriptionsGithubPath(),
	pushSubscriptionsGithubBranch:
		process.env.PUSH_SUBSCRIPTIONS_GITHUB_BRANCH || "main",
	pushSubscriptionsGithubToken:
		process.env.PUSH_SUBSCRIPTIONS_GITHUB_TOKEN || "",
	lineStorageGithubPath:
		process.env.LINE_STORAGE_GITHUB_PATH || "line-auth/storage.enc.json",
	lineStorageBackupKey: process.env.LINE_STORAGE_BACKUP_KEY || "",
	lineStorageBackupIntervalMs: Number(process.env.LINE_STORAGE_BACKUP_INTERVAL_MS || 30_000),
	loginRetryMs: Number(process.env.LINE_LOGIN_RETRY_MS || 15_000),
	authWatchdogMs: Number(process.env.LINE_AUTH_WATCHDOG_MS || 60_000),
	talkPollTimeoutMs: Number(process.env.LINE_TALK_POLL_TIMEOUT_MS || 5_000),
	talkPollIntervalMs: Number(process.env.LINE_TALK_POLL_INTERVAL_MS || 250),
	eventPushSubscriptionsFile: path.resolve(
		process.env.EVENT_PUSH_SUBSCRIPTIONS_FILE || "./storage/event-push-subscriptions.json",
	),
	eventPushStateFile: path.resolve(
		process.env.EVENT_PUSH_STATE_FILE || "./storage/event-push-state.json",
	),
	eventPushSubscriptionsGithubPath:
		process.env.EVENT_PUSH_SUBSCRIPTIONS_GITHUB_PATH || "subscriptions/event-start.json",
	eventPushStateGithubPath:
		process.env.EVENT_PUSH_STATE_GITHUB_PATH || "state/event-start-notifications.json",
	eventPushIntervalMs: Number(process.env.EVENT_PUSH_INTERVAL_MS || 15_000),
	eventPushLookbackMs: Number(process.env.EVENT_PUSH_LOOKBACK_MS || 10 * 60_000),
	pushRemindersFile: path.resolve(
		process.env.PUSH_REMINDERS_FILE || "./storage/push-reminders.json",
	),
	pushRemindersGithubPath:
		process.env.PUSH_REMINDERS_GITHUB_PATH || "state/push-reminders.json",
	pushReminderIntervalMs: Number(process.env.PUSH_REMINDER_INTERVAL_MS || 10_000),
	rankingFile: path.resolve(process.env.RANKING_FILE || "./storage/ranking.json"),
	rankingGithubPath: process.env.RANKING_GITHUB_PATH || "stats/ranking.json",
	botStatusFile: path.resolve(process.env.BOT_STATUS_FILE || "./storage/bot-status.json"),
	botStatusGithubPath: process.env.BOT_STATUS_GITHUB_PATH || "stats/bot-status.json",
	permissionsFile: path.resolve(process.env.PERMISSIONS_FILE || "./storage/permissions.json"),
	permissionsGithubPath: process.env.PERMISSIONS_GITHUB_PATH || "settings/permissions.json",
	ocKickHistoryFile: path.resolve(process.env.OC_KICK_HISTORY_FILE || "./storage/oc-kick-history.json"),
	ocKickHistoryGithubPath: process.env.OC_KICK_HISTORY_GITHUB_PATH || "moderation/oc-kick-history.json",
	memberNameHistoryFile: path.resolve(process.env.MEMBER_NAME_HISTORY_FILE || "./storage/member-name-history.json"),
	memberNameHistoryGithubPath: process.env.MEMBER_NAME_HISTORY_GITHUB_PATH || "logs/member-name-history.json",
	memberNameScanIntervalMs: Number(process.env.MEMBER_NAME_SCAN_INTERVAL_MS || 30 * 60_000),
	messageLogFile: path.resolve(process.env.MESSAGE_LOG_FILE || "./storage/message-log.json"),
	messageLogDir: path.resolve(process.env.MESSAGE_LOG_DIR || "./storage/message-log"),
	messageLogGithubPath: process.env.MESSAGE_LOG_GITHUB_PATH || "logs/message-log.json",
	messageLogBackfillDelayMs: Number(process.env.MESSAGE_LOG_BACKFILL_DELAY_MS || 1_500),
	messageLogBackfillLocalFlushPages: Number(process.env.MESSAGE_LOG_BACKFILL_LOCAL_FLUSH_PAGES || 2),
	messageLogBackfillRemoteFlushPages: Number(process.env.MESSAGE_LOG_BACKFILL_REMOTE_FLUSH_PAGES || 2),
	messageLogPartMaxBytes: Number(process.env.MESSAGE_LOG_PART_MAX_BYTES || 5 * 1024 * 1024),
	messageLogAutoFlushMs: Number(process.env.MESSAGE_LOG_AUTO_FLUSH_MS || 120_000),
	messageLogAutoHistoryEnabled: boolEnv("MESSAGE_LOG_AUTO_HISTORY_ENABLED", true),
	messageLogAutoHistoryIntervalMs: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_INTERVAL_MS || 10 * 60_000),
	messageLogAutoHistoryIdleMs: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_IDLE_MS || 10 * 60_000),
	messageLogAutoHistoryQuietStartHour: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_QUIET_START_HOUR || 2),
	messageLogAutoHistoryQuietEndHour: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_QUIET_END_HOUR || 6),
	messageLogAutoHistoryRecentPages: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_RECENT_PAGES || 2),
	messageLogAutoHistoryBackfillPages: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_BACKFILL_PAGES || 3),
	githubContentsTimeoutMs: Number(process.env.GITHUB_CONTENTS_TIMEOUT_MS || 60_000),
};

export function getPasswordCredentials(): { email: string; password: string } {
	return {
		email: requiredEnv("LINE_EMAIL"),
		password: requiredEnv("LINE_PASSWORD"),
	};
}
