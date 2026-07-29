import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@evex/linejs";
import {
	banSquareMember,
	isBannedMembershipState,
	kickAndBanSquareMember,
} from "../src/moderation/ocSquareBan.js";

function mockClient(returnedState: unknown) {
	let updateRequest: unknown;
	const calls: string[] = [];
	const client = {
		base: {
			square: {
				async getSquareMember({ squareMemberMid }: { squareMemberMid: string }) {
					calls.push("get");
					return {
						squareMember: {
							squareMemberMid,
							squareMid: "s-test",
							displayName: "target",
							membershipState: "JOINED",
							role: "MEMBER",
							revision: 42,
						},
					};
				},
				async updateSquareMember(input: {
					request: {
						updatedAttrs: number[];
						updatedPreferenceAttrs: number[];
						squareMember: Record<string, unknown>;
					};
				}) {
					calls.push("ban");
					updateRequest = input;
					return {
						squareMember: {
							...input.request.squareMember,
							membershipState: returnedState,
						},
					};
				},
			},
		},
	} as unknown as Client;
	return {
		client,
		calls,
		getUpdateRequest: () => updateRequest as {
			request: {
				updatedAttrs: number[];
				updatedPreferenceAttrs: number[];
				squareMember: Record<string, unknown>;
			};
		},
	};
}

test("updates the Square membership state to BANNED", async () => {
	const mock = mockClient("BANNED");

	const response = await banSquareMember(mock.client, "p-target");
	const request = mock.getUpdateRequest().request;

	assert.deepEqual(request.updatedAttrs, [5]);
	assert.deepEqual(request.updatedPreferenceAttrs, []);
	assert.deepEqual(request.squareMember, {
		squareMemberMid: "p-target",
		squareMid: "s-test",
		revision: 42,
		membershipState: "BANNED",
	});
	assert.equal(response.squareMember.membershipState, "BANNED");
});

test("accepts the numeric BANNED state returned by Thrift", () => {
	assert.equal(isBannedMembershipState(6), true);
	assert.equal(isBannedMembershipState("6"), true);
});

test("manual moderation moves a joined member directly to BANNED", async () => {
	const mock = mockClient("BANNED");

	await kickAndBanSquareMember(mock.client, "p-target");
	const request = mock.getUpdateRequest().request;

	assert.deepEqual(mock.calls, ["get", "ban"]);
	assert.equal(request.squareMember.membershipState, "BANNED");
	assert.equal(request.squareMember.revision, 42);
});

test("does not report a KICK_OUT-only response as a successful ban", async () => {
	const mock = mockClient("KICK_OUT");

	await assert.rejects(
		() => banSquareMember(mock.client, "p-target"),
		/Square ban was not confirmed/,
	);
});

test("manual moderation reports failure when the direct ban is rejected", async () => {
	const mock = mockClient("KICK_OUT");

	await assert.rejects(
		() => kickAndBanSquareMember(mock.client, "p-target"),
		/Square member ban failed/,
	);
	assert.deepEqual(mock.calls, ["get", "ban"]);
});
