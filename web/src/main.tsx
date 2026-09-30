import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
