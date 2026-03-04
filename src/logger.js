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

export function makeLogger({ errorsLogPath }) {
	const writeErr = (line) => {
		try {
			fs.mkdirSync(path.dirname(errorsLogPath), { recursive: true });
			fs.appendFileSync(errorsLogPath, line + "\n", "utf8");
		} catch {
			// ignore
		}
	};
	
	const fmt = (lvl, msg) => `${ts()} [ ${lvl} ] ${msg}`;
	
	return {
		info(msg) {
			console.log(chalk.cyan(fmt("I", msg)));
		},
		warn(msg) {
			console.log(chalk.yellow(fmt("W", msg)));
		},
		error(msg, errObj = null) {
			console.log(chalk.red(fmt("E", msg)));
			if (errObj) {
				const dump =
					typeof errObj === "string"
						? errObj
						: JSON.stringify(errObj, null, 2);
				writeErr(`${fmt("E", msg)}\n${dump}\n---`);
			} else {
				writeErr(fmt("E", msg));
			}
		}
	};
}