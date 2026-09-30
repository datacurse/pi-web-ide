import { useEffect, useRef, useState } from "react";
import { Barbell } from "@phosphor-icons/react";
import { WORKOUT_KINDS, type WorkoutKind } from "../shared/types.js";
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

export function pickWorkout(): WorkoutKind {
	return WORKOUT_KINDS[Math.floor(Math.random() * WORKOUT_KINDS.length)];
}

/**
 * Shown right after a prompt goes out, so pi answers while you exercise.
 * Only Done closes it, after SECONDS; the set is logged for Stats.
 */
export function Workout({ kind, onDone }: { kind: WorkoutKind; onDone: () => void }) {
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

	const done = () => {
		void api.workouts.$post({ json: { kind } }).catch(() => undefined);
		onDone();
	};

	return (
		<dialog
			ref={ref}
			aria-label={t("Workout")}
			onCancel={(e) => e.preventDefault()}
			className="mx-auto mt-[24vh] hidden w-[min(24rem,92vw)] flex-col items-center gap-4 rounded-md border border-neutral-800 bg-neutral-950 p-6 text-neutral-100 shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm open:flex"
		>
			<Barbell size={32} className="text-amber-400" />
			<p className="text-center text-title">
				{kind === "pushups" ? t("Do 10 pushups") : t("Do 10 situps")}
			</p>
			<p className="text-meta text-neutral-500">{t("pi is already answering.")}</p>
			<Button variant="primary" disabled={left > 0} onClick={done} autoFocus={left === 0}>
				{left > 0 ? t("Done in {n}s", { n: left }) : t("Done")}
			</Button>
		</dialog>
	);
}
