import type { Client } from "@evex/linejs";
import { appConfig } from "../config.js";
import { permissionStore } from "../permissions/store.js";
import { pushReminderStore, type PushReminder } from "./store.js";

function mentionLabel(reminder: PushReminder): string {
	const name = reminder.userName?.replace(/\s+/g, " ").trim() || "user";
	return `@${name}`;
}

function reminderMessage(reminder: PushReminder): { text: string; contentMetadata: Record<string, string> } {
	const label = mentionLabel(reminder);
	return {
		text: `${label}\n${reminder.message}`,
		contentMetadata: {
			MENTION: JSON.stringify({
				MENTIONEES: [{
					S: "0",
					E: String(label.length),
					M: reminder.userMid,
				}],
			}),
		},
	};
}

async function sendReminder(client: Client, reminder: PushReminder): Promise<"sent" | "stopped"> {
	if (permissionStore.isBotStopped(reminder)) return "stopped";
	const { text, contentMetadata } = reminderMessage(reminder);
	if (reminder.kind === "square") {
		await client.base.square.sendMessage({
			squareChatMid: reminder.chatMid,
			text,
			contentMetadata,
		});
		return "sent";
	}
	await client.base.talk.sendMessage({
		to: reminder.chatMid,
		text,
		contentMetadata,
		e2ee: reminder.encrypted,
	});
	return "sent";
}

export async function checkPushReminders(client: Client, now: Date): Promise<void> {
	const due = pushReminderStore.listDue(now);
	if (due.length === 0) return;

	const delivered: string[] = [];
	for (const reminder of due) {
		try {
			await sendReminder(client, reminder);
			delivered.push(reminder.id);
		} catch (error) {
			console.error(`[push:reminder] delivery failed for ${reminder.kind}:${reminder.chatMid}`, error);
		}
	}
	await pushReminderStore.remove(delivered);
}

export function startPushReminderScheduler(
	getClient: () => Client | null,
	signal: AbortSignal,
): void {
	let running = false;
	const run = async () => {
		if (running || signal.aborted) return;
		const client = getClient();
		if (!client) return;
		running = true;
		try {
			await checkPushReminders(client, new Date());
		} catch (error) {
			console.error("[push:reminder] scheduler check failed", error);
		} finally {
			running = false;
		}
	};

	const interval = setInterval(() => void run(), appConfig.pushReminderIntervalMs);
	const initial = setTimeout(() => void run(), 5_000);
	signal.addEventListener("abort", () => {
		clearInterval(interval);
		clearTimeout(initial);
	}, { once: true });
	console.log(`[push:reminder] scheduler started (${appConfig.pushReminderIntervalMs}ms, JST)`);
}
