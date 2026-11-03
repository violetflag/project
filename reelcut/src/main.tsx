import { render } from "preact";
import { App } from "./ui/App";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./style.css";

render(<App />, document.getElementById("app")!);
