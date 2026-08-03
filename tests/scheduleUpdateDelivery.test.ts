import assert from "node:assert/strict";
import test from "node:test";

import { ScheduleUpdateDeliveryCoordinator } from "../src/scheduleUpdates/delivery.js";

test("schedule update notifications run one at a time", async () => {
	const coordinator = new ScheduleUpdateDeliveryCoordinator();
	const order: string[] = [];
	let releaseFirst!: () => void;
	let markFirstStarted!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});

	const first = coordinator.runNotification(async () => {
		order.push("first:start");
		markFirstStarted();
		await firstGate;
		order.push("first:end");
	});
	await firstStarted;
	const second = coordinator.runNotification(async () => {
		order.push("second");
	});

	assert.deepEqual(order, ["first:start"]);
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("schedule update test is rejected while delivery is busy", async () => {
	const coordinator = new ScheduleUpdateDeliveryCoordinator();
	let releaseNotification!: () => void;
	let markNotificationStarted!: () => void;
	const notificationGate = new Promise<void>((resolve) => {
		releaseNotification = resolve;
	});
	const notificationStarted = new Promise<void>((resolve) => {
		markNotificationStarted = resolve;
	});
	const notification = coordinator.runNotification(async () => {
		markNotificationStarted();
		await notificationGate;
	});
	await notificationStarted;

	let testRan = false;
	const result = await coordinator.tryRunTest(async () => {
		testRan = true;
	});
	assert.deepEqual(result, { accepted: false });
	assert.equal(testRan, false);

	releaseNotification();
	await notification;
});

test("notification waits for an active test and then runs next", async () => {
	const coordinator = new ScheduleUpdateDeliveryCoordinator();
	let releaseTest!: () => void;
	let markTestStarted!: () => void;
	const testGate = new Promise<void>((resolve) => {
		releaseTest = resolve;
	});
	const testStarted = new Promise<void>((resolve) => {
		markTestStarted = resolve;
	});
	const testRun = coordinator.tryRunTest(async () => {
		markTestStarted();
		await testGate;
	});
	await testStarted;

	let notificationRan = false;
	const notification = coordinator.runNotification(async () => {
		notificationRan = true;
	});
	assert.equal(notificationRan, false);

	releaseTest();
	await Promise.all([testRun, notification]);
	assert.equal(notificationRan, true);
});
