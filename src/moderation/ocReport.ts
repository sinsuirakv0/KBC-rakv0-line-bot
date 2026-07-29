import type { Client } from "@evex/linejs";

export type OcReportType =
	| "ADVERTISING"
	| "GENDER_HARASSMENT"
	| "HARASSMENT"
	| "OTHER"
	| "IRRELEVANT_CONTENT"
	| "IMPERSONATION"
	| "SCAM";

export interface OcMessageReport {
	squareMid: string;
	squareChatMid: string;
	messageId: string;
	reportType: OcReportType;
	otherReason?: string;
	threadMid?: string;
}

export async function reportOcMessage(client: Client, report: OcMessageReport): Promise<void> {
	await client.base.square.reportSquareMessage({
		request: {
			squareMid: report.squareMid,
			squareChatMid: report.squareChatMid,
			squareMessageId: report.messageId,
			reportType: report.reportType,
			otherReason: report.otherReason ?? "",
			...(report.threadMid ? { threadMid: report.threadMid } : {}),
		},
	});
}
