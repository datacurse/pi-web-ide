import { useEffect, useRef, useState } from "react";
import { EXERCISES, WORKOUT_KINDS, type WorkoutKind } from "../shared/types.js";
import { Button } from "./ui.js";
import { t } from "./i18n.js";
import { api } from "./api.js";
import { WorkoutFigure } from "./workoutFigures.js";

/**
 * A random exercise among those switched on (Packages > pwi extensions), or
 * null when the workout gate is off or the server cannot say.
 */
export async function pickWorkout(): Promise<WorkoutKind | null> {
	const r = await api["pwi-extensions"].$get().catch(() => null);
	if (!r?.ok) return null;
	const s = await r.json();
	const on = WORKOUT_KINDS.filter((k) => !s.workoutOff.includes(k));
	if (!s.workout || on.length === 0) return null;
	return on[Math.floor(Math.random() * on.length)];
}

/** The exercise's name (Stats) and what the dialog asks for. */
export function exerciseText(kind: WorkoutKind): { name: string; task: string } {
	const n = EXERCISES[kind].amount;
	switch (kind) {
		case "pushups":
			return { name: t("Pushups"), task: t("Do {n} pushups", { n }) };
		case "situps":
			return { name: t("Situps"), task: t("Do {n} situps", { n }) };
		case "squats":
			return { name: t("Squats"), task: t("Do {n} squats", { n }) };
		case "lunges":
			return { name: t("Lunges"), task: t("Do {n} lunges on each leg", { n: n / 2 }) };
		case "burpees":
			return { name: t("Burpees"), task: t("Do {n} burpees", { n }) };
		case "jumpingJacks":
			return { name: t("Jumping jacks"), task: t("Do {n} jumping jacks", { n }) };
		case "calfRaises":
			return { name: t("Calf raises"), task: t("Do {n} calf raises", { n }) };
		case "gluteBridges":
			return { name: t("Glute bridges"), task: t("Do {n} glute bridges", { n }) };
		case "plank":
			return { name: t("Plank"), task: t("Hold a plank for {n} seconds", { n }) };
		case "wallSit":
			return { name: t("Wall sit"), task: t("Hold a wall sit for {n} seconds", { n }) };
	}
}

/**
 * Shown right after a prompt goes out, so pi answers while you exercise.
 * Only Done closes it, once the exercise's wait is over; the set is logged for Stats.
 */
export function Workout({ kind, onDone }: { kind: WorkoutKind; onDone: () => void }) {
	const ref = useRef<HTMLDialogElement>(null);
	const wait = EXERCISES[kind].wait;
	const [left, setLeft] = useState<number>(wait);

	useEffect(() => {
		ref.current?.showModal();
		const start = Date.now();
		const id = setInterval(() => {
			const next = Math.max(0, wait - Math.floor((Date.now() - start) / 1000));
			setLeft(next);
			if (next === 0) clearInterval(id);
		}, 250);
		return () => clearInterval(id);
	}, [wait]);

	const done = () => {
		void api.workouts.$post({ json: { kind } }).catch(() => undefined);
		onDone();
	};

	return (
		<dialog
			ref={ref}
			aria-label={t("Workout")}
			onCancel={(e) => e.preventDefault()}
			// Enter is Done once it unlocks, wherever focus sits in the dialog.
			onKeyDown={(e) => {
				if (e.key !== "Enter") return;
				e.preventDefault();
				if (left === 0) done();
			}}
			className="mx-auto mt-[20vh] hidden w-[min(24rem,92vw)] flex-col items-center gap-4 rounded-md border border-neutral-800 bg-neutral-950 p-6 text-neutral-100 shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm open:flex"
		>
			<WorkoutFigure kind={kind} className="w-full text-amber-400" />
			<p className="text-center text-title">{exerciseText(kind).task}</p>
			<p className="text-meta text-neutral-500">{t("pi is already answering.")}</p>
			<Button variant="primary" disabled={left > 0} onClick={done}>
				{left > 0 ? t("Done in {n}s", { n: left }) : t("Done")}
			</Button>
		</dialog>
	);
}
