import { useMemo, useState } from "react";
import { FolderPlus, X } from "@phosphor-icons/react";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { Button } from "./ui.js";

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
		<div className="flex items-center gap-1 border-b border-neutral-800 px-2 py-1.5">
			<select
				value={project}
				onChange={(e) => onProject(e.target.value)}
				title={project}
				aria-label="Project"
				className="min-w-0 flex-1 truncate rounded-sm bg-neutral-900 px-1.5 py-1 text-meta text-neutral-300 outline-none"
			>
				{options.map((p) => (
					<option key={p} value={p}>
						{labelFor(p)}
					</option>
				))}
			</select>
			{/* A folder icon, not a bare `+`: `+` elsewhere makes a session. */}
			<Button
				variant="subtle"
				size="sm"
				onClick={() => setPickerOpen(true)}
				disabled={!!projects.error}
				aria-label="Add project directory"
				title="Add project directory"
			>
				<FolderPlus size={13} />
			</Button>
			{/*
			  Not offered for the seed: the server re-adds it on every read, so the
			  button would appear to do nothing. Confirmed, and the wording says
			  what is NOT happening, since "remove project" usually means the files.
			*/}
			{project && !projects.error && project !== projects.seed && (
				<Button
					variant="subtle"
					size="sm"
					onClick={() => {
						if (
							confirm(
								`Remove ${project} from the project list?\n\nThe directory and its sessions stay on disk — this only hides them here.`,
							)
						) {
							onRemoveProject(project);
						}
					}}
					aria-label={`Remove ${project} from the list`}
					title="Remove this project from the list (keeps sessions on disk)"
				>
					<X size={13} />
				</Button>
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
