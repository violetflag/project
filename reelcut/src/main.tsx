import { render } from "preact";
import { App } from "./ui/App";
// Static (hinted) weights: the variable font renders blurry at 100% scale on Windows.
import "pretendard/dist/web/static/Pretendard-Regular.css";
import "pretendard/dist/web/static/Pretendard-Medium.css";
import "pretendard/dist/web/static/Pretendard-SemiBold.css";
import "pretendard/dist/web/static/Pretendard-Bold.css";
import "./style.css";

render(<App />, document.getElementById("app")!);
