/* @refresh reload */
import { render } from "solid-js/web";
import "./styles/base.css";
import "./styles/shell.css";
import App from "./App";

render(() => <App />, document.getElementById("root")!);
