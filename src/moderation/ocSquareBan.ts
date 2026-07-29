import type { Client } from "@evex/linejs";

const MEMBERSHIP_STATE_ATTRIBUTE = 5;
const BANNED_MEMBERSHIP_STATE = 6;

function validateSquareMemberMid(squareMemberMid: string): void {
	if (!squareMemberMid.startsWith("p")) {
		throw new Error("Invalid value: squareMemberMid");
	}
}

export function isBannedMembershipState(state: unknown): boolean {
	return state === "BANNED" || state === BANNED_MEMBERSHIP_STATE || state === String(BANNED_MEMBERSHIP_STATE);
}

function membershipStateUpdate(squareMember: {
	squareMemberMid?: string;
	squareMid?: string;
	revision?: number | bigint;
}, membershipState: "BANNED") {
	if (!squareMember.squareMemberMid || !squareMember.squareMid || squareMember.revision === undefined) {
		throw new Error("Square member data required for membership-state update was missing");
	}
	return {
		squareMemberMid: squareMember.squareMemberMid,
		squareMid: squareMember.squareMid,
		revision: squareMember.revision,
		membershipState,
	};
}

async function updateMembershipStateToBanned(client: Client, squareMemberMid: string) {
	const current = await client.base.square.getSquareMember({ squareMemberMid });
	const response = await client.base.square.updateSquareMember({
		request: {
			updatedAttrs: [MEMBERSHIP_STATE_ATTRIBUTE],
			updatedPreferenceAttrs: [],
			squareMember: membershipStateUpdate(current.squareMember, "BANNED"),
		},
	});

	if (!isBannedMembershipState(response.squareMember?.membershipState)) {
		throw new Error(
			`Square ban was not confirmed: membershipState=${String(response.squareMember?.membershipState)}`,
		);
	}
	return response;
}

export async function banSquareMember(client: Client, squareMemberMid: string) {
	validateSquareMemberMid(squareMemberMid);
	return await updateMembershipStateToBanned(client, squareMemberMid);
}

export async function kickAndBanSquareMember(client: Client, squareMemberMid: string) {
	validateSquareMemberMid(squareMemberMid);
	try {
		// BANNED は即時退会と再参加禁止を同時に行う。KICK_OUT 後は更新できないため直接遷移する。
		return await updateMembershipStateToBanned(client, squareMemberMid);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Square member ban failed: ${detail}`,
		);
	}
}
