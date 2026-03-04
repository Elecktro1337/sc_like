import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function ensureDir(p) {
	fs.mkdirSync(p, { recursive: true });
}

export function exists(p) {
	try {
		fs.accessSync(p, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function readJson(filePath, fallback = null) {
	try {
		const s = fs.readFileSync(filePath, "utf8");
		return JSON.parse(s);
	} catch {
		return fallback;
	}
}

export function writeJson(filePath, data) {
	const tmp = `${filePath}.tmp`;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
	fs.renameSync(tmp, filePath);
}

export function appendText(filePath, line) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, line + "\n", "utf8");
}

export function readTextLines(filePath) {
	const raw = fs.readFileSync(filePath, "utf8");
	return raw
	.split(/\r?\n/g)
	.map((l) => l.trim())
	.filter((l) => l && !l.startsWith("#"));
}

export function resolveRel(...parts) {
	return path.resolve(process.cwd(), ...parts);
}

export function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

export function sha256File(filePath) {
	const buf = fs.readFileSync(filePath);
	return crypto.createHash("sha256").update(buf).digest("hex");
}

export function listJsonFiles(dirPath) {
	if (!exists(dirPath)) return [];
	const items = fs.readdirSync(dirPath, { withFileTypes: true });
	return items
	.filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".json"))
	.map((d) => d.name);
}