import { createRoot } from "react-dom/client";
import { App, isReport } from "./App.tsx";

const embedded = window.__SECONDPASS_REPORT__;
const root = document.getElementById("root");
if (root) createRoot(root).render(<App initial={isReport(embedded) ? embedded : undefined} />);
