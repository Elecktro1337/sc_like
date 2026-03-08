import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";

function pad(n) {
	return String(n).padStart(2, "0");
}

export function ts() {
	const d = new Date();
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function safeStringify(value) {
	try {
		return typeof value === "string" ? value : JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function sanitizeHeaders(headers) {
	if (!headers || typeof headers !== "object") return headers;
	
	const out = { ...headers };
	
	for (const key of Object.keys(out)) {
		if (key.toLowerCase() === "authorization") {
			out[key] = "OAuth <hidden>";
		}
	}
	
	return out;
}

export function makeLogger({ errorsLogPath, requestsLogPath = null }) {
	const writeLine = (targetPath, line) => {
		try {
			fs.mkdirSync(path.dirname(targetPath), { recursive: true });
			fs.appendFileSync(targetPath, line + "\n", "utf8");
		} catch {
			// ignore
		}
	};
	
	const clearLogFile = (targetPath) => {
		try {
			fs.mkdirSync(path.dirname(targetPath), { recursive: true });
			fs.writeFileSync(targetPath, "", "utf8");
		} catch {
			// ignore
		}
	};
	
	const fmt = (lvl, msg) => `${ts()} [ ${lvl} ] ${msg}`;
	
	return {
		clearErrorsLog() {
			clearLogFile(errorsLogPath);
		},
		clearRequestsLog() {
			if (requestsLogPath) clearLogFile(requestsLogPath);
		},
		info(msg) {
			console.log(chalk.cyan(fmt("I", msg)));
		},
		warn(msg) {
			console.log(chalk.yellow(fmt("W", msg)));
		},
		error(msg, errObj = null) {
			console.log(chalk.red(fmt("E", msg)));
			if (errObj) {
				writeLine(errorsLogPath, `${fmt("E", msg)}\n${safeStringify(errObj)}\n---`);
			} else {
				writeLine(errorsLogPath, fmt("E", msg));
			}
		},
		request(event, payload = null) {
			if (!requestsLogPath) return;
			
			let prepared = payload;
			if (payload && typeof payload === "object") {
				prepared = { ...payload };
				if (prepared.headers) {
					prepared.headers = sanitizeHeaders(prepared.headers);
				}
				if (prepared.requestHeaders) {
					prepared.requestHeaders = sanitizeHeaders(prepared.requestHeaders);
				}
			}
			
			if (prepared) {
				writeLine(requestsLogPath, `${fmt("R", event)}\n${safeStringify(prepared)}\n---`);
			} else {
				writeLine(requestsLogPath, fmt("R", event));
			}
		}
	};
}