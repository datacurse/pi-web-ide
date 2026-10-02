import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { showScrollbarsWhileScrolling } from "./OverlayScrollbar.js";
import { nativeMenuOnDoubleRightClick } from "./ui.js";
import "./index.css";
import "./settings-highlight.css";

showScrollbarsWhileScrolling();
nativeMenuOnDoubleRightClick();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
