import { appConfig } from "../config.js";

interface GithubFileResponse {
	content?: string;
	encoding?: string;
	sha?: string;
}

export interface GithubTextFile {
	content: string;
	sha?: string;
}

export class GithubContentsClient {
	get enabled(): boolean {
		return Boolean(
			appConfig.pushSubscriptionsGithubRepo && appConfig.pushSubscriptionsGithubToken,
		);
	}

	async read(filePath: string): Promise<GithubTextFile | null> {
		const url = new URL(this.url(filePath));
		url.searchParams.set("ref", appConfig.pushSubscriptionsGithubBranch);
		const response = await fetch(url, { headers: this.headers() });
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`GitHub read failed: HTTP ${response.status}`);
		const file = await response.json() as GithubFileResponse;
		if (file.encoding !== "base64" || !file.content) {
			throw new Error("GitHub file is not base64 content");
		}
		return {
			content: Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"),
			sha: file.sha,
		};
	}

	async write(
		filePath: string,
		content: string,
		message: string,
		sha?: string,
	): Promise<string | undefined> {
		const response = await this.put(filePath, content, message, sha);
		if (response.status === 409) {
			const latest = await this.read(filePath);
			if (latest?.sha) {
				console.warn(`[github] sha conflict while writing ${filePath}; retrying with latest sha`);
				const retry = await this.put(filePath, content, message, latest.sha);
				if (retry.ok) {
					const result = await retry.json() as { content?: { sha?: string } };
					return result.content?.sha;
				}
				const detail = await retry.text();
				throw new Error(`GitHub write failed: HTTP ${retry.status} ${detail.slice(0, 300)}`);
			}
		}
		if (!response.ok) {
			const detail = await response.text();
			throw new Error(`GitHub write failed: HTTP ${response.status} ${detail.slice(0, 300)}`);
		}
		const result = await response.json() as { content?: { sha?: string } };
		return result.content?.sha;
	}

	private async put(
		filePath: string,
		content: string,
		message: string,
		sha?: string,
	): Promise<Response> {
		return await fetch(this.url(filePath), {
			method: "PUT",
			headers: { ...this.headers(), "Content-Type": "application/json" },
			body: JSON.stringify({
				message,
				content: Buffer.from(content, "utf8").toString("base64"),
				branch: appConfig.pushSubscriptionsGithubBranch,
				...(sha ? { sha } : {}),
			}),
		});
	}

	async delete(filePath: string, message: string, sha: string): Promise<void> {
		const response = await fetch(this.url(filePath), {
			method: "DELETE",
			headers: { ...this.headers(), "Content-Type": "application/json" },
			body: JSON.stringify({
				message,
				sha,
				branch: appConfig.pushSubscriptionsGithubBranch,
			}),
		});
		if (!response.ok) {
			const detail = await response.text();
			throw new Error(`GitHub delete failed: HTTP ${response.status} ${detail.slice(0, 300)}`);
		}
	}

	private url(filePath: string): string {
		const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
		return `https://api.github.com/repos/${appConfig.pushSubscriptionsGithubRepo}/contents/${encodedPath}`;
	}

	private headers(): Record<string, string> {
		return {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${appConfig.pushSubscriptionsGithubToken}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "KBC-rakv0-line-bot",
		};
	}
}

export const githubContentsClient = new GithubContentsClient();
