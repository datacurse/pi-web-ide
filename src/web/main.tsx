import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { showScrollbarsWhileScrolling } from "./OverlayScrollbar.js";
import "./index.css";

showScrollbarsWhileScrolling();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
