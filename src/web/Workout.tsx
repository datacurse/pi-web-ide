import { useEffect, useRef, useState } from "react";
import { Barbell } from "@phosphor-icons/react";
import { Button } from "./ui.js";
import { t } from "./i18n.js";
import { api } from "./api.js";

/** About how long 10 reps take, getting down and up included. */
const SECONDS = 15;

/** Whether the workout gate is on (Packages > pwi extensions). Off if the server cannot say. */
export async function workoutOn(): Promise<boolean> {
	const r = await api["pwi-extensions"].$get().catch(() => null);
	if (!r?.ok) return false;
	return (await r.json()).workout;
}

/** Asks for 10 pushups or situps; Done unlocks after SECONDS and sends. */
export function Workout({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
	const ref = useRef<HTMLDialogElement>(null);
	const [left, setLeft] = useState(SECONDS);

	useEffect(() => {
		ref.current?.showModal();
		const start = Date.now();
		const id = setInterval(() => {
			const next = Math.max(0, SECONDS - Math.floor((Date.now() - start) / 1000));
			setLeft(next);
			if (next === 0) clearInterval(id);
		}, 250);
		return () => clearInterval(id);
	}, []);

	return (
		<dialog
			ref={ref}
			aria-label={t("Workout")}
			onClose={onCancel}
			className="mx-auto mt-[24vh] hidden w-[min(24rem,92vw)] flex-col items-center gap-4 rounded-md border border-neutral-800 bg-neutral-950 p-6 text-neutral-100 shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm open:flex"
		>
			<Barbell size={32} className="text-amber-400" />
			<p className="text-center text-title">{t("Do 10 pushups or 10 situps")}</p>
			<p className="text-meta text-neutral-500">{t("Your prompt goes out when you press Done.")}</p>
			<div className="flex gap-2">
				<Button onClick={onCancel}>{t("Cancel")}</Button>
				<Button variant="primary" disabled={left > 0} onClick={onDone} autoFocus={left === 0}>
					{left > 0 ? t("Done in {n}s", { n: left }) : t("Done")}
				</Button>
			</div>
		</dialog>
	);
}
