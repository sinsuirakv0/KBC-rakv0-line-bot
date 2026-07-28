import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();

export type LoginMethod = "qr" | "password" | "token";

function boolEnv(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined || value === "") return fallback;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function optionalBoolEnv(name: string): boolean | undefined {
	const raw = process.env[name]?.trim().toLowerCase();
	if (!raw || raw === "auto") return undefined;
	if (["1", "true", "yes", "on"].includes(raw)) return true;
	if (["0", "false", "no", "off"].includes(raw)) return false;
	throw new Error(`${name} must be auto, true, or false`);
}

function numberEnv(
	name: string,
	fallback: number,
	options: { min?: number; max?: number; integer?: boolean } = {},
): number {
	const raw = process.env[name];
	const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
	let value = Number.isFinite(parsed) ? parsed : fallback;
	if (options.integer) value = Math.floor(value);
	if (options.min !== undefined) value = Math.max(options.min, value);
	if (options.max !== undefined) value = Math.min(options.max, value);
	return value;
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
	loginV3: optionalBoolEnv("LINE_LOGIN_V3"),
	storageFile: path.resolve(process.env.LINE_STORAGE_FILE || "./storage/storage.json"),
	forceLogin: boolEnv("LINE_FORCE_LOGIN", false),
	e2eeLogin: boolEnv("LINE_E2EE_LOGIN", true),
	commandPrefix: process.env.COMMAND_PREFIX || "!",
	commandMaxConcurrency: numberEnv("COMMAND_MAX_CONCURRENCY", 2, { min: 1, max: 4, integer: true }),
	commandQueueLimit: numberEnv("COMMAND_QUEUE_LIMIT", 30, { min: 5, max: 100, integer: true }),
	backgroundQuietMs: numberEnv("BACKGROUND_QUIET_MS", 15_000, { min: 0, integer: true }),
	backgroundRetryMs: numberEnv("BACKGROUND_RETRY_MS", 10_000, { min: 1_000, integer: true }),
	backgroundMaxEventLoopLagMs: numberEnv("BACKGROUND_MAX_EVENT_LOOP_LAG_MS", 250, {
		min: 50,
		integer: true,
	}),
	backgroundLagCooldownMs: numberEnv("BACKGROUND_LAG_COOLDOWN_MS", 30_000, {
		min: 5_000,
		integer: true,
	}),
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
	authFailureThreshold: numberEnv("LINE_AUTH_FAILURE_THRESHOLD", 2, {
		min: 2,
		max: 5,
		integer: true,
	}),
	authFailureRetryMs: numberEnv("LINE_AUTH_FAILURE_RETRY_MS", 5_000, {
		min: 1_000,
		max: 60_000,
		integer: true,
	}),
	talkPollTimeoutMs: Number(process.env.LINE_TALK_POLL_TIMEOUT_MS || 5_000),
	talkPollIntervalMs: Number(process.env.LINE_TALK_POLL_INTERVAL_MS || 250),
	talkPollStaleMs: Number(process.env.LINE_TALK_POLL_STALE_MS || 90_000),
	squarePollStaleMs: Number(process.env.LINE_SQUARE_POLL_STALE_MS || 120_000),
	staleRestartThreshold: numberEnv("LINE_STALE_RESTART_THRESHOLD", 2, {
		min: 2,
		max: 5,
		integer: true,
	}),
	ocMemberMessageRetryMs: Number(process.env.OC_MEMBER_MESSAGE_RETRY_MS || 5_000),
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
	rankingSaveDelayMs: numberEnv("RANKING_SAVE_DELAY_MS", 60_000, { min: 5_000, integer: true }),
	botStatusFile: path.resolve(process.env.BOT_STATUS_FILE || "./storage/bot-status.json"),
	botStatusGithubPath: process.env.BOT_STATUS_GITHUB_PATH || "stats/bot-status.json",
	botLogRelayFile: path.resolve(process.env.BOT_LOG_RELAY_FILE || "./storage/bot-log-relay.json"),
	botLogRelayGithubPath:
		process.env.BOT_LOG_RELAY_GITHUB_PATH || "settings/bot-log-relay.json",
	botLogRelayTalkMid:
		process.env.BOT_LOG_RELAY_TALK_MID || "c1b419211a74dbc992a4b597bf69dc20b",
	botLogRelayE2ee: boolEnv("BOT_LOG_RELAY_E2EE", true),
	botLogRelayBatchMs: numberEnv("BOT_LOG_RELAY_BATCH_MS", 3_000, {
		min: 1_000,
		max: 60_000,
		integer: true,
	}),
	botLogRelayMaxQueue: numberEnv("BOT_LOG_RELAY_MAX_QUEUE", 500, {
		min: 50,
		max: 5_000,
		integer: true,
	}),
	permissionsFile: path.resolve(process.env.PERMISSIONS_FILE || "./storage/permissions.json"),
	permissionsGithubPath: process.env.PERMISSIONS_GITHUB_PATH || "settings/permissions.json",
	ocKickHistoryFile: path.resolve(process.env.OC_KICK_HISTORY_FILE || "./storage/oc-kick-history.json"),
	ocKickHistoryGithubPath: process.env.OC_KICK_HISTORY_GITHUB_PATH || "moderation/oc-kick-history.json",
	ocModerationSettingsFile: path.resolve(
		process.env.OC_MODERATION_SETTINGS_FILE || "./storage/oc-moderation-settings.json",
	),
	ocModerationSettingsGithubPath:
		process.env.OC_MODERATION_SETTINGS_GITHUB_PATH || "moderation/oc-moderation-settings.json",
	ocMemberActivityFile: path.resolve(
		process.env.OC_MEMBER_ACTIVITY_FILE || "./storage/oc-member-activity.json",
	),
	ocMemberActivityGithubPath:
		process.env.OC_MEMBER_ACTIVITY_GITHUB_PATH || "moderation/oc-member-activity.json",
	ocMemberActivitySaveDelayMs: numberEnv("OC_MEMBER_ACTIVITY_SAVE_DELAY_MS", 30_000, {
		min: 5_000,
		integer: true,
	}),
	ocRecentPresenceFile: path.resolve(
		process.env.OC_RECENT_PRESENCE_FILE || "./storage/oc-recent-presence.json",
	),
	ocRecentPresenceGithubPath:
		process.env.OC_RECENT_PRESENCE_GITHUB_PATH || "moderation/oc-recent-presence.json",
	ocRecentPresenceSaveDelayMs: numberEnv("OC_RECENT_PRESENCE_SAVE_DELAY_MS", 10_000, {
		min: 1_000,
		integer: true,
	}),
	ocModerationCasesFile: path.resolve(
		process.env.OC_MODERATION_CASES_FILE || "./storage/oc-moderation-cases.json",
	),
	ocModerationCasesGithubPath:
		process.env.OC_MODERATION_CASES_GITHUB_PATH || "moderation/oc-moderation-cases.json",
	ocIdentitySnapshotsFile: path.resolve(
		process.env.OC_IDENTITY_SNAPSHOTS_FILE || "./storage/oc-identity-snapshots.json",
	),
	ocIdentitySnapshotsGithubPath:
		process.env.OC_IDENTITY_SNAPSHOTS_GITHUB_PATH || "moderation/oc-identity-snapshots.json",
	ocMediaBurstWindowMs: Number(process.env.OC_MEDIA_BURST_WINDOW_MS || 30_000),
	ocMediaBurstLimit: Number(process.env.OC_MEDIA_BURST_LIMIT || 7),
	memberNameHistoryFile: path.resolve(process.env.MEMBER_NAME_HISTORY_FILE || "./storage/member-name-history.json"),
	memberNameHistoryGithubPath: process.env.MEMBER_NAME_HISTORY_GITHUB_PATH || "logs/member-name-history.json",
	memberNameHistorySaveDelayMs: numberEnv("MEMBER_NAME_HISTORY_SAVE_DELAY_MS", 60_000, {
		min: 5_000,
		integer: true,
	}),
	memberNameScanIntervalMs: Number(process.env.MEMBER_NAME_SCAN_INTERVAL_MS || 30 * 60_000),
	messageLogFile: path.resolve(process.env.MESSAGE_LOG_FILE || "./storage/message-log.json"),
	messageLogDir: path.resolve(process.env.MESSAGE_LOG_DIR || "./storage/message-log"),
	messageLogGithubPath: process.env.MESSAGE_LOG_GITHUB_PATH || "logs/message-log.json",
	messageLogBackfillDelayMs: Number(process.env.MESSAGE_LOG_BACKFILL_DELAY_MS || 1_500),
	messageLogBackfillLocalFlushPages: Number(process.env.MESSAGE_LOG_BACKFILL_LOCAL_FLUSH_PAGES || 2),
	messageLogBackfillRemoteFlushPages: Number(process.env.MESSAGE_LOG_BACKFILL_REMOTE_FLUSH_PAGES || 2),
	messageLogRemoteFlushMaxFiles: Number(process.env.MESSAGE_LOG_REMOTE_FLUSH_MAX_FILES || 8),
	messageLogRemoteSyncIntervalMs: Number(process.env.MESSAGE_LOG_REMOTE_SYNC_INTERVAL_MS || 60_000),
	messageLogRemoteSyncBacklogMs: Number(process.env.MESSAGE_LOG_REMOTE_SYNC_BACKLOG_MS || 30_000),
	messageLogRemoteReconcileEnabled: boolEnv("MESSAGE_LOG_REMOTE_RECONCILE_ENABLED", true),
	messageLogRemoteReconcileDelayMs: Number(process.env.MESSAGE_LOG_REMOTE_RECONCILE_DELAY_MS || 15_000),
	messageLogPartMaxBytes: Number(process.env.MESSAGE_LOG_PART_MAX_BYTES || 5 * 1024 * 1024),
	messageLogAutoFlushMs: Number(process.env.MESSAGE_LOG_AUTO_FLUSH_MS || 120_000),
	messageLogAutoHistoryEnabled: boolEnv("MESSAGE_LOG_AUTO_HISTORY_ENABLED", true),
	messageLogAutoHistoryIntervalMs: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_INTERVAL_MS || 10 * 60_000),
	messageLogAutoHistoryIdleMs: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_IDLE_MS || 10 * 60_000),
	messageLogAutoHistoryQuietStartHour: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_QUIET_START_HOUR || 2),
	messageLogAutoHistoryQuietEndHour: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_QUIET_END_HOUR || 6),
	messageLogAutoHistoryRecentPages: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_RECENT_PAGES || 2),
	messageLogAutoHistoryBackfillPages: Number(process.env.MESSAGE_LOG_AUTO_HISTORY_BACKFILL_PAGES || 3),
	memberEventLogDir: path.resolve(process.env.MEMBER_EVENT_LOG_DIR || "./storage/member-event-log"),
	memberEventLogGithubPath:
		process.env.MEMBER_EVENT_LOG_GITHUB_PATH || "logs/member-event-log",
	memberEventLogSaveDelayMs: numberEnv("MEMBER_EVENT_LOG_SAVE_DELAY_MS", 30_000, {
		min: 5_000,
		integer: true,
	}),
	memberEventLogRemoteSyncIntervalMs: numberEnv(
		"MEMBER_EVENT_LOG_REMOTE_SYNC_INTERVAL_MS",
		60_000,
		{ min: 10_000, integer: true },
	),
	memberEventLogRemoteSyncBacklogMs: numberEnv(
		"MEMBER_EVENT_LOG_REMOTE_SYNC_BACKLOG_MS",
		30_000,
		{ min: 5_000, integer: true },
	),
	memberEventLogRemoteFlushMaxFiles: numberEnv(
		"MEMBER_EVENT_LOG_REMOTE_FLUSH_MAX_FILES",
		8,
		{ min: 1, max: 50, integer: true },
	),
	githubContentsTimeoutMs: Number(process.env.GITHUB_CONTENTS_TIMEOUT_MS || 60_000),
	githubContentsWriteIntervalMs: Number(process.env.GITHUB_CONTENTS_WRITE_INTERVAL_MS || 1_000),
};

export function getPasswordCredentials(): { email: string; password: string } {
	return {
		email: requiredEnv("LINE_EMAIL"),
		password: requiredEnv("LINE_PASSWORD"),
	};
}
