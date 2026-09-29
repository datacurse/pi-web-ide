/**
 * bash.ts — pi's own bash tool, registered again with its process
 * operations wrapped, so each command of a call is timed and its output
 * counted (trace.bash, markers.ts, steps.ts).
 *
 * pi's tool still does everything it does: the same definition, truncation,
 * temp file, `PI_*` environment and exit handling. Only the spawn's env gains
 * `BASH_ENV` and the output passes through MarkerStrip on its way in. A call
 * that sets its own `BASH_ENV` or turns on `set -x` runs untraced, and any
 * error in the instrumentation turns it off for the rest of the session.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Step } from "./format.ts";
import { MarkerStrip } from "./markers.ts";
import { buildSteps, parseTrace } from "./steps.ts";

const TRACE = fileURLToPath(new URL("./trace.bash", import.meta.url));
/** `set -x`, `set -euxo pipefail`, `set -o xtrace`: bash would print the trap into the output. */
const XTRACE = /\bset\s+(-[a-zA-Z]*x|-o\s+xtrace)/;
/** pi's bash tool keeps the last 50KB when it truncates. */
const SHOWN_BYTES = 50 * 1024;

type ExecOptions = { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv };
type Operations = { exec(command: string, cwd: string, options: ExecOptions): Promise<{ exitCode: number | null }> };
type Params = { command: string; timeout?: number };
type Definition = Record<string, unknown> & {
	execute(id: string, params: Params, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
};
type Options = { shellPath?: string; commandPrefix?: string; operations?: Operations };

/** The part of pi's package this uses, loaded at runtime: pi is not a dependency here. */
export interface PiTools {
	createBashToolDefinition(cwd: string, options?: Options): Definition;
	createLocalBashOperations(options?: { shellPath?: string }): Operations;
	SettingsManager: {
		create(cwd: string): { getShellPath(): string | undefined; getShellCommandPrefix(): string | undefined };
	};
}

export interface BashRun {
	steps: Step[];
	background: { pid: number; step?: number; t: number }[];
}

export function instrumentBash(
	pi: { registerTool(tool: unknown): void },
	tools: PiTools,
	done: (toolCallId: string, run: BashRun) => void,
) {
	const settings = tools.SettingsManager.create(process.cwd());
	const options: Options = { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() };
	const local = tools.createLocalBashOperations({ shellPath: options.shellPath });
	const plain = tools.createBashToolDefinition(process.cwd(), options);
	let off = false;

	pi.registerTool({
		...plain,
		async execute(id: string, params: Params, signal: unknown, onUpdate: unknown, ctx: unknown) {
			if (off || typeof params?.command !== "string" || XTRACE.test(params.command))
				return plain.execute(id, params, signal, onUpdate, ctx);
			let trace: string;
			let strip: MarkerStrip;
			let nonce: string;
			try {
				nonce = randomBytes(6).toString("hex");
				trace = join(tmpdir(), `pwi-tool-metrics-${randomUUID()}.tsv`);
				writeFileSync(trace, "", { mode: 0o600 });
				strip = new MarkerStrip(nonce);
			} catch {
				off = true;
				return plain.execute(id, params, signal, onUpdate, ctx);
			}
			let broken = false;
			let traced = true;
			let ended = 0;
			const operations: Operations = {
				exec(command, cwd, o) {
					const env = o.env ?? process.env;
					if (env.BASH_ENV) {
						traced = false;
						return local.exec(command, cwd, o);
					}
					return local
						.exec(command, cwd, {
							...o,
							env: { ...env, BASH_ENV: TRACE, PWI_TM_TRACE: trace, PWI_TM_MARK: nonce },
							onData(data) {
								let clean = data;
								if (!broken) {
									try {
										clean = strip.push(data);
									} catch {
										broken = true;
									}
								}
								if (clean.length) o.onData(clean);
							},
						})
						.finally(() => {
							ended = Date.now();
							if (broken) return;
							const rest = strip.flush();
							if (rest.length) o.onData(rest);
						});
				},
			};
			let result: unknown;
			try {
				result = await tools
					.createBashToolDefinition(process.cwd(), { ...options, operations })
					.execute(id, params, signal, onUpdate, ctx);
				return result;
			} finally {
				try {
					if (traced && !broken) {
						// pi throws on a non-zero exit, so there is no result then; the output
						// was under the limit unless it was longer than it.
						const truncated = (result as { details?: { truncation?: { outputBytes?: number } } } | undefined)
							?.details?.truncation?.outputBytes;
						const shown = result === undefined ? Math.min(strip.bytes, SHOWN_BYTES) : (truncated ?? strip.bytes);
						done(
							id,
							buildSteps({
								command: params.command,
								prefix: options.commandPrefix,
								trace: parseTrace(readFileSync(trace, "utf8")),
								marks: strip.at,
								total: strip.bytes,
								shownFrom: strip.bytes - shown,
								ended: ended || Date.now(),
							}),
						);
					}
					rmSync(trace, { force: true });
				} catch {
					off = true;
				}
			}
		},
	});
}
