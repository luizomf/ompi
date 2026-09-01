import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { chromium, type Browser, type Page } from "playwright-core";
import { createBackgroundToolManager } from "./background-tool.ts";

const NAVIGATION_TIMEOUT_MS = 20_000;
const RENDER_WAIT_MS = 2_000;
const MAX_LINKS = 100;
const MAX_TEXT_CHARS = 200_000;
const MIN_READABLE_CHARS = 120;

const browserFetchParameters = Type.Object({
	url: Type.String({
		description: "Absolute HTTP or HTTPS URL to fetch",
	}),
});

interface ExtractedPage {
	finalUrl: string;
	title: string;
	text: string;
	links: Array<{ text: string; url: string }>;
}

type RetrievalOutcome =
	| "retrieved"
	| "access_block"
	| "http_failure"
	| "no_http_response"
	| "no_readable_content";

interface BrowserFetchDetails {
	url: string;
	finalUrl: string;
	title: string;
	status: number | null;
	retrievalOutcome: RetrievalOutcome;
	fullOutputPath?: string;
}

function resolveBrowserExecutable(): string {
	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	const localAppData = process.env.LOCALAPPDATA;
	const candidates = [
		process.env.BROWSER_FETCH_CHROMIUM_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/google-chrome",
		programFiles && join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
		programFilesX86 && join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
		localAppData && join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
		programFiles && join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
		programFilesX86 && join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
	].filter((candidate): candidate is string => Boolean(candidate));

	const executable = candidates.find(existsSync);
	if (!executable) {
		throw new Error(
			"No Chromium-based browser found. Set BROWSER_FETCH_CHROMIUM_PATH to its executable.",
		);
	}

	return executable;
}

function parseUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported URL protocol: ${url.protocol}`);
	}

	return url;
}

function normalizeText(value: unknown): string {
	return String(value ?? "")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
}

function detectsAccessBlock(title: string, text: string, finalUrl: string): boolean {
	try {
		if (new URL(finalUrl).searchParams.has("js_challenge")) return true;
	} catch {
		// The requested URL was validated before navigation.
	}

	const sample = `${title}\n${text.slice(0, 6_000)}`.toLowerCase();
	const patterns = [
		/captcha/,
		/verify (that )?you are human/,
		/are you a human/,
		/robot check/,
		/unusual traffic/,
		/checking your browser/,
		/access denied/,
		/temporarily blocked/,
		/sign in to continue/,
		/log in to continue/,
		/login required/,
		/you must be logged in/,
		/enable cookies to continue/,
	];

	return patterns.some((pattern) => pattern.test(sample));
}

async function extractPage(page: Page): Promise<ExtractedPage> {
	const extracted = await page.evaluate((linkLimit) => {
		const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
		const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
			.map((anchor) => ({
				text: clean(
					anchor.innerText ||
						anchor.getAttribute("aria-label") ||
						anchor.getAttribute("title") ||
						anchor.href,
				),
				url: anchor.href,
			}))
			.filter((link) => link.url)
			.slice(0, linkLimit * 3);

		return {
			finalUrl: window.location.href,
			title: document.title,
			text: document.body?.innerText ?? "",
			links,
		};
	}, MAX_LINKS);

	const seen = new Set<string>();
	const links: Array<{ text: string; url: string }> = [];
	for (const link of extracted.links) {
		try {
			const url = new URL(link.url);
			if (!["http:", "https:"].includes(url.protocol) || seen.has(url.href)) continue;
			seen.add(url.href);
			links.push({ text: normalizeText(link.text).slice(0, 200), url: url.href });
			if (links.length >= MAX_LINKS) break;
		} catch {
			// Ignore malformed links from the page.
		}
	}

	return {
		finalUrl: extracted.finalUrl,
		title: normalizeText(extracted.title).slice(0, 500),
		text: normalizeText(extracted.text).slice(0, MAX_TEXT_CHARS),
		links,
	};
}

function formatPage(page: ExtractedPage): string {
	const sections = [
		`Title: ${page.title || "(untitled)"}`,
		`URL: ${page.finalUrl}`,
		"",
		page.text,
	];

	if (page.links.length > 0) {
		sections.push(
			"",
			"Links:",
			...page.links.map((link) => `- ${link.text || link.url}: ${link.url}`),
		);
	}

	return sections.join("\n");
}

function hostedFallbackTarget(requestedUrl: URL, hostname: string): URL | undefined {
	if (requestedUrl.hostname.toLowerCase() !== hostname) return undefined;
	const rawTarget = `${requestedUrl.pathname.slice(1)}${requestedUrl.search}${requestedUrl.hash}`;
	try {
		const target = new URL(rawTarget);
		return target.protocol === "http:" || target.protocol === "https:" ? target : undefined;
	} catch {
		return undefined;
	}
}

function nextExactUrlStage(requestedUrl: string): string {
	const parsed = new URL(requestedUrl);
	const jinaTarget = hostedFallbackTarget(parsed, "r.jina.ai");
	if (jinaTarget) {
		return "Exact-URL fallback chain is exhausted. Report that the page could not be accessed or verified; do not invent page-specific facts or imply that the page was read.";
	}

	const markdownTarget = hostedFallbackTarget(parsed, "markdown.new");
	if (markdownTarget) {
		return [
			"Next exact-URL stage (only if third-party disclosure is authorized): call browser_fetch with",
			`https://r.jina.ai/${markdownTarget.href}`,
			"Do not restart the fallback chain from that transformed URL.",
		].join(" ");
	}

	return [
		"Next exact-URL stage: call codex_search with effort \"quick\" and explicitly require it to fetch and extract",
		`this exact URL (${requestedUrl}) and disclose if exact-URL access failed.`,
		"Related prose, snippets, and pages are not proof of access.",
	].join(" ");
}

function retrievalFailure(
	summary: string,
	requestedUrl: string,
	details: BrowserFetchDetails,
) {
	const locations = [`Requested URL: ${requestedUrl}`];
	if (details.finalUrl !== requestedUrl) locations.push(`Final URL: ${details.finalUrl}`);
	return {
		content: [{
			type: "text" as const,
			text: [summary, ...locations, "", nextExactUrlStage(requestedUrl)].join("\n"),
		}],
		details,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	const background = createBackgroundToolManager(pi, {
		namespace: "browser-fetch",
		statusLabel: "browser_fetch",
		maxActive: 4,
	});

	pi.registerTool(background.wrapTool({
		name: "browser_fetch",
		label: "Browser Fetch",
		description: `Fetch a user-authorized HTTP or HTTPS page with a fresh headless Chromium profile and return its rendered readable text and links. It attempts every valid HTTP or HTTPS destination without classifying DNS answers, IP ranges, loopback, private networks, or metadata addresses; authorization remains the caller's responsibility. In print mode, the tool waits and returns the result directly. In other modes, it runs asynchronously: the call returns immediately after starting bounded background work and completion may arrive later only while the owning Pi session remains live. Use it when curl cannot read a page or JavaScript rendering is required. It does not bypass logins, CAPTCHAs, or anti-bot checks; agents should continue the available exact-URL fallback chain rather than infer page contents. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Fetch a rendered page and continue exact-URL fallbacks when blocked",
		promptGuidelines: [
			"Use browser_fetch only for an HTTP or HTTPS destination the user has authorized; the tool does not impose a public/private network classification.",
			"For the contents of a specific authorized URL, use this strict, non-looping fallback sequence, advancing after a transport error, HTTP failure, CAPTCHA, anti-bot or login block, empty or unreadable output, or inability to establish exact-target access: (1) ordinary direct HTTP/curl on the original URL; (2) browser_fetch on the original URL; (3) codex_search with effort quick and an explicit instruction to fetch and extract the exact URL rather than merely search for related pages, and to disclose if exact-URL access failed; (4) browser_fetch on https://markdown.new/<absolute-target-URL>; (5) browser_fetch on https://r.jina.ai/<absolute-target-URL>.",
			"Do not restart the chain for a transformed fallback URL at markdown.new or r.jina.ai, and do not repeat a completed stage.",
			"Treat markdown.new and r.jina.ai as third-party disclosure boundaries. Do not submit target URLs containing credentials, signed or private query parameters, or confidential identifiers to them without explicit user authorization.",
			"A model-produced answer, snippets, or related pages do not prove access to the supplied URL. If every safe stage fails, explicitly state that you could not access or verify the URL and must not invent page-specific facts or imply that you read it.",
			"When multiple browser_fetch calls or other research calls are independently useful, start them in the same turn so Pi can run them concurrently; outside print mode, do not wait for one result before starting another.",
			"In print mode, browser_fetch returns the rendered result directly; inspect it before continuing dependent work.",
			"Outside print mode, after browser_fetch starts background work, never wait, sleep, or poll for its result. Continue only useful independent work or end the response; a later result can be delivered only while the owning Pi session remains live.",
		],
		parameters: browserFetchParameters,

		async execute(_toolCallId, params, signal) {
			const requestedUrl = parseUrl(params.url).href;
			let browser: Browser | undefined;
			let aborted = false;
			let phase = "browser startup";
			const ensureActive = () => {
				if (aborted) throw new Error("Browser fetch cancelled");
			};
			const abortHandler = () => {
				aborted = true;
				void browser?.close().catch(() => undefined);
			};
			signal?.addEventListener("abort", abortHandler, { once: true });

			try {
				browser = await chromium.launch({
					executablePath: resolveBrowserExecutable(),
					headless: true,
					args: ["--disable-dev-shm-usage", "--disable-extensions"],
				});
				ensureActive();
				phase = "browser/context setup";
				const context = await browser.newContext();
				const page = await context.newPage();
				page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);

				phase = "transport or navigation";
				const response = await page.goto(requestedUrl, {
					waitUntil: "domcontentloaded",
					timeout: NAVIGATION_TIMEOUT_MS,
				});
				await page
					.waitForLoadState("networkidle", { timeout: RENDER_WAIT_MS })
					.catch(() => undefined);

				ensureActive();
				phase = "rendering or extraction";

				const extracted = await extractPage(page);
				const status = response?.status() ?? null;
				const accessBlocked = detectsAccessBlock(
					extracted.title,
					extracted.text,
					extracted.finalUrl,
				);
				const details: BrowserFetchDetails = {
					url: requestedUrl,
					finalUrl: extracted.finalUrl,
					title: extracted.title,
					status,
					retrievalOutcome: "retrieved",
				};

				if (accessBlocked) {
					details.retrievalOutcome = "access_block";
					const statusText = status === null ? "without an HTTP status" : `with HTTP ${status}`;
					return retrievalFailure(
						`Rendered retrieval encountered a login, CAPTCHA, anti-bot, or other access-block response ${statusText} at ${extracted.finalUrl}.`,
						requestedUrl,
						details,
					);
				}

				if (status === null) {
					details.retrievalOutcome = "no_http_response";
					return retrievalFailure(
						`Rendered navigation produced no HTTP response for ${extracted.finalUrl}, so exact-target access could not be established.`,
						requestedUrl,
						details,
					);
				}

				if (status >= 400) {
					details.retrievalOutcome = "http_failure";
					return retrievalFailure(
						`Rendered retrieval received an HTTP failure (HTTP ${status}) at ${extracted.finalUrl}.`,
						requestedUrl,
						details,
					);
				}

				if (extracted.text.length < MIN_READABLE_CHARS) {
					details.retrievalOutcome = "no_readable_content";
					return retrievalFailure(
						`Rendered retrieval produced unreadable content (${extracted.text.length} characters; at least ${MIN_READABLE_CHARS} required) at ${extracted.finalUrl}.`,
						requestedUrl,
						details,
					);
				}

				const fullOutput = formatPage(extracted);
				const truncation = truncateHead(fullOutput, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				let output = truncation.content;

				if (truncation.truncated) {
					phase = "bounded output persistence";
					const directory = await mkdtemp(join(tmpdir(), "pi-browser-fetch-"));
					const fullOutputPath = join(directory, "page.txt");
					await writeFile(fullOutputPath, fullOutput, "utf8");
					details.fullOutputPath = fullOutputPath;
					output += `\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
				}

				return {
					content: [{ type: "text" as const, text: output }],
					details,
				};
			} catch (error) {
				if (aborted) throw new Error("Browser fetch cancelled", { cause: error });
				throw new Error([
					`Rendered retrieval ${phase} failed for ${requestedUrl}.`,
					`Cause: ${errorMessage(error)}`,
					"",
					nextExactUrlStage(requestedUrl),
				].join("\n"), { cause: error });
			} finally {
				signal?.removeEventListener("abort", abortHandler);
				await browser?.close().catch(() => undefined);
			}
		},
	}));
}
