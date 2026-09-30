import { useMemo, useState } from "react";
import { CaretDown, FolderPlus, X } from "@phosphor-icons/react";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { StripCell } from "./ui.js";
import { t } from "./i18n.js";

/**
 * The project list this pwi reports: every directory, plus the cwd it was
 * launched against.
 */
export interface Projects {
	projects: string[];
	/** This pwi's startup cwd: always listed, never removable. */
	seed: string;
	error?: string;
}

/**
 * Project picker, shown at the top of the Explorer. One active project at a
 * time: switching swaps the file tree AND the session list, which keeps the
 * 5s session poll at exactly one request.
 *
 * Adding opens a folder explorer over the SERVER's filesystem
 * (DirectoryPicker): the browser cannot enumerate it, and its own directory
 * input would offer the wrong folders entirely.
 */
export function ProjectPicker({
	projects,
	project,
	onProject,
	onAddProject,
	onRemoveProject,
}: {
	projects: Projects;
	/** The selected project: a cwd on this machine. */
	project: string;
	onProject: (cwd: string) => void;
	onAddProject: (path: string) => void;
	onRemoveProject: (path: string) => void;
}) {
	/*
	 * The selection stays in the list even while the list has not arrived (or
	 * failed to), so the dropdown never shows a blank for the project on screen.
	 */
	const options = useMemo(
		() =>
			projects.projects.length > 0 || !project ? projects.projects : [project],
		[projects.projects, project],
	);

	/*
	 * Dropdown labels. The basename alone is what you think of the project as,
	 * but two checkouts of the same repo are then the same word twice — so a
	 * basename that is not unique carries its parent directory.
	 */
	const labelFor = useMemo(() => {
		const base = (p: string) => p.split("/").filter(Boolean).pop() || p;
		const counts = new Map<string, number>();
		for (const p of options) counts.set(base(p), (counts.get(base(p)) ?? 0) + 1);
		return (p: string) => {
			const parts = p.split("/").filter(Boolean);
			const name = parts.at(-1) || p;
			return (counts.get(name) ?? 0) > 1 && parts.length > 1
				? `${parts.at(-2)}/${name}`
				: name;
		};
	}, [options]);

	const [pickerOpen, setPickerOpen] = useState(false);

	return (
		<div className="flex h-bar shrink-0 items-stretch border-b border-neutral-800">
			<div className="relative flex min-w-0 flex-1">
			<select
				data-custom="the whole row, like the session search field"
				value={project}
				onChange={(e) => onProject(e.target.value)}
				title={project}
				aria-label={t("Project")}
				className="min-w-0 flex-1 cursor-pointer appearance-none bg-neutral-950 pr-8 pl-3 text-ui text-neutral-100 outline-none transition-colors duration-150 ease-out hover:bg-neutral-900 motion-reduce:transition-none"
			>
				{options.map((p) => (
					<option key={p} value={p}>
						{labelFor(p)}
					</option>
				))}
			</select>
			<CaretDown size={14} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-neutral-500" />
			</div>
			{/* A folder icon, not a bare `+`: `+` elsewhere makes a session. */}
			<StripCell
				onClick={() => setPickerOpen(true)}
				disabled={!!projects.error}
				label={t("Add project directory")}
			>
				<FolderPlus size={16} />
			</StripCell>
			{/*
			  Not offered for the seed: the server re-adds it on every read, so the
			  button would appear to do nothing. Confirmed, and the wording says
			  what is NOT happening, since "remove project" usually means the files.
			*/}
			{project && !projects.error && project !== projects.seed && (
				<StripCell
					onClick={() => {
						if (
							confirm(
								t(
									"Remove {project} from the project list?\n\nThe directory and its sessions stay on disk — this only hides them here.",
									{ project },
								),
							)
						) {
							onRemoveProject(project);
						}
					}}
					label={t("Remove {project} from the list", { project })}
				>
					<X size={16} />
				</StripCell>
			)}
			{/* `open` drives showModal(), so an unopened picker never fetches. */}
			<DirectoryPicker
				open={pickerOpen}
				start={project}
				projects={projects.projects}
				onPick={(p) => {
					onAddProject(p);
					setPickerOpen(false);
				}}
				onClose={() => setPickerOpen(false)}
			/>
		</div>
	);
}
