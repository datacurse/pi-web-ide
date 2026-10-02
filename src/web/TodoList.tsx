import type { TodoTask } from "../shared/todos.js";
import { t } from "./i18n.js";
import { ScrollPane } from "./OverlayScrollbar.js";

/** Live task progress beside the answer’s Show work disclosure. */
export function TodoList({ tasks }: { tasks: TodoTask[] }) {
	if (!tasks.length) return null;
	const completed = tasks.filter((task) => task.status === "completed").length;
	return (
		<section aria-label={t("Todos")} className="mb-4 text-ui">
			<div className="mb-2 text-neutral-400">{t("Todos")} ({completed}/{tasks.length})</div>
			<ScrollPane className="max-h-48">
				<ul className="space-y-1">
					{tasks.map((task) => (
						<li key={task.id} className={`flex gap-2 ${task.status === "in_progress" ? "text-blue-400" : task.status === "completed" ? "text-neutral-500" : "text-neutral-300"}`}>
							<span aria-label={t(task.status === "in_progress" ? "In progress" : task.status === "completed" ? "Completed" : "Pending")}>
								{task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : "○"}
							</span>
							<span className={task.status === "completed" ? "line-through" : ""}>
								{task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject}
							</span>
						</li>
					))}
				</ul>
			</ScrollPane>
		</section>
	);
}
