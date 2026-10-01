import { AUTOMATIC_ACTIONS, DEFAULT_AUTOMATIC_MODEL, type AutomaticAction, type AutomaticModels } from "../shared/automaticModels.js";
import { statePath, writeStateFile } from "./state.js";
import { modelCatalog } from "./models.js";
import { readSolPi, writeSolPi } from "./solPi.js";
import { automaticModel, readAutomaticModels } from "./automaticModelConfig.js";

export function automaticModels(cwd: string): AutomaticModels {
	const c = readSolPi(cwd).config;
	return {
		commitNaming: automaticModel("commitNaming"),
		sessionNaming: automaticModel("sessionNaming"),
		compaction: automaticModel("compaction"),
		reducer: c.evidencePreservingReducerProvider && c.evidencePreservingReducerModel
			? `${c.evidencePreservingReducerProvider}/${c.evidencePreservingReducerModel}` : DEFAULT_AUTOMATIC_MODEL,
	};
}

export function setAutoCompaction(enabled: unknown): void {
	if (typeof enabled !== "boolean") throw new Error("autoCompaction must be a boolean");
	writeStateFile(statePath("automatic-models.json"), `${JSON.stringify({ ...readAutomaticModels(), autoCompaction: enabled }, null, 2)}\n`);
}

export async function setAutomaticModel(action: unknown, model: unknown, cwd: string): Promise<void> {
	if (!AUTOMATIC_ACTIONS.includes(action as AutomaticAction)) throw new Error("unknown automatic action");
	if (typeof model !== "string" || !(await modelCatalog()).has(model)) throw new Error(`unknown model: ${String(model)}`);
	if (action === "reducer") {
		const slash = model.indexOf("/");
		writeSolPi({ evidencePreservingReducerProvider: model.slice(0, slash), evidencePreservingReducerModel: model.slice(slash + 1) }, cwd);
	} else {
		writeStateFile(statePath("automatic-models.json"), `${JSON.stringify({ ...readAutomaticModels(), [action as string]: model }, null, 2)}\n`);
	}
}
