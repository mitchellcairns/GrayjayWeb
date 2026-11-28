/* @refresh reload */
import { render } from "solid-js/web";
import "./styles/base.css";
import "./styles/shell.css";
import App from "./App";
import { reloadForUpdate } from "./lib/update";

// [GrayjayWeb] A page's stylesheet or shared file from before a server update is gone: reload into the new build.
window.addEventListener("vite:preloadError", (e) => { if (reloadForUpdate()) e.preventDefault(); });

render(() => <App />, document.getElementById("root")!);
