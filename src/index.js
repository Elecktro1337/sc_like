import inquirer from "inquirer";
import figlet from "figlet";
import ora from "ora";
import chalk from "chalk";
import crypto from "node:crypto";
import http from "node:http";
import open from "open";
import cliProgress from "cli-progress";

import { SoundCloudClient } from "./sc.js";
import { parseLine, pickBestMatch } from "./match.js";
import {
	ensureDir,
	exists,
	listJsonFiles,
	readJson,
	writeJson,
	readTextLines,
	appendText,
	resolveRel,
	sleep,
	sha256File,
	clearFile
} from "./store.js";
import { makeLogger } from "./logger.js";
import { exchangeTokenAuthCode, refreshToken, makePkce } from "./oauth.js";

/**
 * SC Like — elecktro1337 (t.me/elecktro1337)
 */

const APP_AUTHOR = "elecktro1337 (t.me/elecktro1337)";

const DATA_DIR = resolveRel("data");
const CONFIGS_DIR = resolveRel("data", "configs");
const PLAYLISTS_DIR = resolveRel("data", "playlists");

const TOKENS_PATH = resolveRel("data", "tokens.json");
const FOUND_PATH = resolveRel("data", "found_tracks.json");
const NOT_FOUND_PATH = resolveRel("data", "not_found.txt");
const STATE_SEARCH_PATH = resolveRel("data", "state_search.json");
const STATE_LIKES_PATH = resolveRel("data", "state_likes.json");
const STATE_PLAYLISTS_PATH = resolveRel("data", "state_playlists.json");
const ERRORS_LOG_PATH = resolveRel("data", "errors.log");
const REQUESTS_LOG_PATH = resolveRel("data", "requests.log");
const STATS_PATH = resolveRel("data", "stats.json");
const TRACKS_TXT = resolveRel("tracks.txt");

const MIN_DELAY_MS = 1500;
const MAX_DELAY_MS = 2 * 60 * 1000;
const PLAYLIST_TRACK_LIMIT = 250;

// экспоненциальное смещение к коротким задержкам
const getLikeDelayMs = () => {
	const u = Math.random();
	const k = 9;
	const t = 1 - Math.exp(-k * u);
	return Math.floor(MIN_DELAY_MS + t * (MAX_DELAY_MS - MIN_DELAY_MS));
};

const SEARCH_DELAY_MS = 200;
const SEARCH_LIMIT = 30;

const log = makeLogger({
	errorsLogPath: ERRORS_LOG_PATH,
	requestsLogPath: REQUESTS_LOG_PATH
});

function clearConsole() {
	process.stdout.write("\x1Bc");
}

function header() {
	const art = figlet.textSync("SC Like", { horizontalLayout: "default" });
	console.log(chalk.green(art));
	console.log(chalk.gray("Версия 1.1.0\n"));
	console.log(chalk.gray(`Автор: ${APP_AUTHOR}\n`));
}

function nowSec() {
	return Math.floor(Date.now() / 1000);
}

function safeResourceRef(resourceOrValue) {
	if (resourceOrValue == null) {
		return { id: null, urn: null, key: null };
	}
	
	if (typeof resourceOrValue === "number") {
		const id = Number.isFinite(resourceOrValue) ? String(resourceOrValue) : null;
		return { id, urn: null, key: id };
	}
	
	if (typeof resourceOrValue === "string") {
		const value = resourceOrValue.trim();
		if (!value) return { id: null, urn: null, key: null };
		
		if (/^soundcloud:/i.test(value)) {
			const numericTail = value.match(/:(\d+)$/);
			return {
				id: numericTail ? numericTail[1] : null,
				urn: value,
				key: value
			};
		}
		
		if (/^\d+$/.test(value)) {
			return { id: value, urn: null, key: value };
		}
		
		return { id: null, urn: null, key: value };
	}
	
	if (typeof resourceOrValue === "object") {
		const key =
			(typeof resourceOrValue.key === "string" && resourceOrValue.key.trim()) ||
			null;
		
		const urn =
			(typeof resourceOrValue.urn === "string" && resourceOrValue.urn.trim()) ||
			null;
		
		const idRaw =
			typeof resourceOrValue.id === "number"
				? String(resourceOrValue.id)
				: (typeof resourceOrValue.id === "string" && resourceOrValue.id.trim()) || null;
		
		const id =
			idRaw && /^\d+$/.test(idRaw)
				? idRaw
				: urn && /:(\d+)$/.test(urn)
					? urn.match(/:(\d+)$/)[1]
					: null;
		
		return {
			id,
			urn,
			key: key || urn || id
		};
	}
	
	return { id: null, urn: null, key: null };
}

function safeResourceKey(resourceOrValue) {
	return safeResourceRef(resourceOrValue).key;
}

function safeNumericId(resourceOrValue) {
	return safeResourceRef(resourceOrValue).id;
}

function initStats() {
	const defaults = {
		updated_at: null,
		search: {
			total_lines: 0,
			parsed_lines: 0,
			found: 0,
			not_found: 0,
			errors: 0,
			started_from: 0,
			finished: false,
			stopped_by_429: false,
			last_index: 0
		},
		likes: {
			total_found: 0,
			processed: 0,
			liked: 0,
			already_liked: 0,
			skipped_by_state: 0,
			errors: 0,
			finished: false,
			stopped_by_429: false,
			last_index: 0
		},
		playlist: {
			total_found: 0,
			processed: 0,
			added: 0,
			already_in_playlist: 0,
			skipped_by_state: 0,
			errors: 0,
			finished: false,
			stopped_by_429: false,
			last_index: 0,
			target_title: null,
			target_url: null,
			target_part: 1
		}
	};
	
	const base = readJson(STATS_PATH, null);
	
	if (!base || typeof base !== "object") {
		writeJson(STATS_PATH, defaults);
		return defaults;
	}
	
	const normalized = {
		updated_at: base.updated_at ?? null,
		search: {
			...defaults.search,
			...(base.search || {})
		},
		likes: {
			...defaults.likes,
			...(base.likes || {})
		},
		playlist: {
			...defaults.playlist,
			...(base.playlist || {})
		}
	};
	
	writeJson(STATS_PATH, normalized);
	return normalized;
}

function saveStats(stats) {
	stats.updated_at = new Date().toISOString();
	writeJson(STATS_PATH, stats);
}

function initLogFiles() {
	ensureDir(DATA_DIR);
	clearFile(ERRORS_LOG_PATH);
	clearFile(REQUESTS_LOG_PATH);
}

async function selectOrCreateConfig() {
	ensureDir(CONFIGS_DIR);
	const configs = listJsonFiles(CONFIGS_DIR);
	
	const { mode } = await inquirer.prompt([
		{
			type: "list",
			name: "mode",
			message: "Конфиг SoundCloud:",
			choices: [
				{ name: "Загрузить существующий", value: "load" },
				{ name: "Создать новый", value: "create" }
			]
		}
	]);
	
	if (mode === "load") {
		if (!configs.length) {
			log.warn("Нет сохраненных конфигов. Создаем новый.");
			return await createConfig();
		}
		
		const { file } = await inquirer.prompt([
			{
				type: "list",
				name: "file",
				message: "Выбери конфиг:",
				choices: configs.map((c) => ({ name: c, value: c }))
			}
		]);
		
		const cfg = readJson(resolveRel("data", "configs", file), null);
		if (!cfg?.client_id || !cfg?.client_secret || !cfg?.redirect_uri) {
			throw new Error("Конфиг битый/неполный. Удали его и создай заново.");
		}
		
		log.info(`Конфиг загружен: ${file}`);
		return cfg;
	}
	
	return await createConfig();
}

async function createConfig() {
	const answers = await inquirer.prompt([
		{ type: "input", name: "name", message: "Имя профиля (например: main):", default: "main" },
		{ type: "input", name: "client_id", message: "SoundCloud Client ID:" },
		{ type: "password", name: "client_secret", message: "SoundCloud Client Secret:" },
		{
			type: "input",
			name: "redirect_uri",
			message: "Redirect URI (должен быть добавлен в настройках приложения):",
			default: "http://127.0.0.1:53682/callback"
		}
	]);
	
	const fileName = `${answers.name}.json`;
	const path = resolveRel("data", "configs", fileName);
	
	const cfg = {
		client_id: answers.client_id,
		client_secret: answers.client_secret,
		redirect_uri: answers.redirect_uri
	};
	
	writeJson(path, cfg);
	log.info(`Конфиг сохранен: ${fileName}`);
	return cfg;
}

async function getValidTokens(cfg, forceRefresh = false) {
	const tok = readJson(TOKENS_PATH, null);
	
	if (!forceRefresh && tok?.access_token && tok?.expires_at && tok.expires_at - nowSec() > 60) {
		return tok;
	}
	
	if (tok?.refresh_token) {
		log.info("Обновляю токен (refresh_token)...");
		const fresh = await refreshToken({
			clientId: cfg.client_id,
			clientSecret: cfg.client_secret,
			refreshToken: tok.refresh_token
		});
		
		const out = { ...fresh, expires_at: nowSec() + (fresh.expires_in || 3600) };
		writeJson(TOKENS_PATH, out);
		return out;
	}
	
	const redirect = new URL(cfg.redirect_uri);
	const listenHost = redirect.hostname;
	const listenPort = Number(redirect.port || 80);
	const callbackPath = redirect.pathname;
	
	const state = crypto.randomBytes(16).toString("hex");
	const pkce = makePkce();
	
	const authorizeUrl = new URL("https://secure.soundcloud.com/authorize");
	authorizeUrl.searchParams.set("client_id", cfg.client_id);
	authorizeUrl.searchParams.set("redirect_uri", cfg.redirect_uri);
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
	authorizeUrl.searchParams.set("code_challenge_method", "S256");
	authorizeUrl.searchParams.set("state", state);
	
	log.info("Открываю браузер для авторизации...");
	
	const code = await new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			try {
				const url = new URL(req.url, cfg.redirect_uri);
				if (url.pathname !== callbackPath) {
					res.writeHead(404);
					res.end("Not Found");
					return;
				}
				
				const gotState = url.searchParams.get("state");
				const gotCode = url.searchParams.get("code");
				const err = url.searchParams.get("error");
				
				if (err) {
					res.writeHead(400);
					res.end(`OAuth error: ${err}`);
					server.close();
					reject(new Error(`OAuth error: ${err}`));
					return;
				}
				
				if (!gotCode) {
					res.writeHead(400);
					res.end("Missing code");
					server.close();
					reject(new Error("Missing code"));
					return;
				}
				
				if (gotState !== state) {
					res.writeHead(400);
					res.end("State mismatch");
					server.close();
					reject(new Error("State mismatch"));
					return;
				}
				
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end("<h3>OK. Закрой вкладку и вернись в консоль.</h3>");
				server.close();
				resolve(gotCode);
			} catch (e) {
				server.close();
				reject(e);
			}
		});
		
		server.listen(listenPort, listenHost, async () => {
			await open(authorizeUrl.toString());
		});
	});
	
	log.info("Обмениваю code -> token...");
	
	const exchanged = await exchangeTokenAuthCode({
		clientId: cfg.client_id,
		clientSecret: cfg.client_secret,
		redirectUri: cfg.redirect_uri,
		code,
		codeVerifier: pkce.verifier
	});
	
	const out = { ...exchanged, expires_at: nowSec() + (exchanged.expires_in || 3600) };
	writeJson(TOKENS_PATH, out);
	return out;
}

function initFiles() {
	ensureDir(DATA_DIR);
	ensureDir(CONFIGS_DIR);
	ensureDir(PLAYLISTS_DIR);
	
	if (!exists(FOUND_PATH)) writeJson(FOUND_PATH, { generated_at: null, tracks_hash: null, found: [] });
	if (!exists(STATE_SEARCH_PATH)) writeJson(STATE_SEARCH_PATH, { tracks_hash: null, next_index: 0, total: 0, updated_at: null });
	if (!exists(STATE_LIKES_PATH)) writeJson(STATE_LIKES_PATH, { liked_ids: {}, updated_at: null });
	if (!exists(STATE_PLAYLISTS_PATH)) writeJson(STATE_PLAYLISTS_PATH, { playlists: {}, roots: {}, updated_at: null });
	if (!exists(NOT_FOUND_PATH)) appendText(NOT_FOUND_PATH, "# not found (Artist - Title) — appended");
	if (!exists(STATS_PATH)) initStats();
}

async function selectActionMode() {
	const { mode } = await inquirer.prompt([
		{
			type: "list",
			name: "mode",
			message: "Режим работы:",
			choices: [
				{ name: "Лайкинг треков", value: "like" },
				{ name: "Добавление треков в плейлист", value: "playlist" }
			]
		}
	]);
	
	return mode;
}

function buildAutoPlaylistProfile() {
	const now = new Date();
	const pad2 = (value) => String(value).padStart(2, "0");
	const year = now.getFullYear();
	const month = pad2(now.getMonth() + 1);
	const day = pad2(now.getDate());
	const hours = pad2(now.getHours());
	const minutes = pad2(now.getMinutes());
	const seconds = pad2(now.getSeconds());
	
	const stamp = `${year}${month}${day}-${hours}${minutes}${seconds}`;
	const title = `SC Like ${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
	
	return {
		name: `auto-${stamp}`,
		url: null,
		title,
		key: null,
		id: null,
		urn: null,
		secret_token: null
	};
}

function normalizePlaylistProfile(saved, fallbackName = "playlist") {
	const ref = safeResourceRef(saved);
	return {
		name: saved?.name || fallbackName,
		url: saved?.url || null,
		title: saved?.title || saved?.name || fallbackName,
		key: ref.key,
		id: ref.id,
		urn: ref.urn,
		secret_token: saved?.secret_token || null
	};
}

function slugifyFilePart(value, fallback = "playlist") {
	const out = String(value || "")
	.trim()
	.toLowerCase()
	.replace(/[^a-z0-9а-яё_-]+/gi, "-")
	.replace(/-+/g, "-")
	.replace(/^-+|-+$/g, "");
	return out || fallback;
}

function normalizePlaylistRootState(saved, playlistProfile) {
	return {
		root_name: saved?.root_name || playlistProfile.name,
		base_title: saved?.base_title || playlistProfile.title || playlistProfile.name || "playlist",
		base_url: saved?.base_url || playlistProfile.url || null,
		active_part: Number.isFinite(saved?.active_part) && saved.active_part > 0 ? saved.active_part : 1,
		active_playlist_key: saved?.active_playlist_key || playlistProfile.key || null,
		active_playlist_id: saved?.active_playlist_id || playlistProfile.id || null,
		parts: saved?.parts && typeof saved.parts === "object"
			? saved.parts
			: {
				1: {
					key: playlistProfile.key || null,
					id: playlistProfile.id || null,
					urn: playlistProfile.urn || null,
					title: playlistProfile.title || playlistProfile.name || "playlist",
					url: playlistProfile.url || null,
					secret_token: playlistProfile.secret_token || null,
					file_name: `${playlistProfile.name}.json`
				}
			}
	};
}

async function resolvePlaylistProfile(sc, saved, fileName = "playlist.json") {
	const normalized = normalizePlaylistProfile(saved, fileName.replace(/\.json$/i, ""));
	
	if (!normalized.url) {
		throw new Error("Профиль плейлиста битый/неполный. Удали его и создай заново.");
	}
	
	const canUseSavedRef = normalized.key || normalized.id || normalized.urn;
	if (canUseSavedRef) {
		try {
			const actual = await sc.getPlaylist(normalized.key || normalized.urn || normalized.id);
			return {
				name: normalized.name,
				url: normalized.url,
				title: actual?.title || normalized.title,
				key: safeResourceKey(actual),
				id: safeNumericId(actual),
				urn: safeResourceRef(actual).urn,
				secret_token: actual?.secret_token || normalized.secret_token || null
			};
		} catch {
			// fallback ниже
		}
	}
	
	const matched = await sc.findMyPlaylistByUrl(normalized.url);
	if (!matched) {
		throw new Error(`Не удалось найти твой плейлист по ссылке: ${normalized.url}`);
	}
	
	return {
		name: normalized.name,
		url: normalized.url,
		title: matched.title || normalized.title,
		key: safeResourceKey(matched),
		id: safeNumericId(matched),
		urn: safeResourceRef(matched).urn,
		secret_token: matched?.secret_token || null
	};
}

async function selectOrCreatePlaylist(sc) {
	ensureDir(PLAYLISTS_DIR);
	const playlists = listJsonFiles(PLAYLISTS_DIR);
	
	const { mode } = await inquirer.prompt([
		{
			type: "list",
			name: "mode",
			message: "Плейлист SoundCloud:",
			choices: [
				{ name: "Выбрать существующий", value: "load" },
				{ name: "Создать новый", value: "create" }
			]
		}
	]);
	
	if (mode === "load") {
		if (!playlists.length) {
			log.warn("Нет сохранённых плейлистов. Создаём новый.");
			return await createPlaylistProfile(sc);
		}
		
		const { file } = await inquirer.prompt([
			{
				type: "list",
				name: "file",
				message: "Выбери плейлист:",
				choices: playlists.map((p) => ({ name: p, value: p }))
			}
		]);
		
		const saved = readJson(resolveRel("data", "playlists", file), null);
		const resolved = await resolvePlaylistProfile(sc, saved, file);
		
		writeJson(resolveRel("data", "playlists", file), {
			name: resolved.name,
			url: resolved.url,
			title: resolved.title,
			key: resolved.key,
			id: resolved.id,
			urn: resolved.urn,
			secret_token: resolved.secret_token
		});
		
		log.info(`Плейлист загружен: ${resolved.title}`);
		return resolved;
	}
	
	return await createPlaylistProfile(sc);
}

async function createPlaylistProfile(sc) {
	const answers = await inquirer.prompt([
		{
			type: "input",
			name: "name",
			message: "Имя профиля плейлиста (например: techno-main):",
			default: "main-playlist"
		},
		{
			type: "input",
			name: "url",
			message: "Ссылка на твой плейлист SoundCloud:"
		}
	]);
	
	const matched = await sc.findMyPlaylistByUrl(answers.url);
	if (!matched) {
		throw new Error("Не удалось найти этот плейлист среди /me/playlists. Убедись, что ссылка ведёт именно на твой плейлист.");
	}
	
	const payload = {
		name: answers.name,
		url: answers.url,
		key: safeResourceKey(matched),
		id: safeNumericId(matched),
		urn: safeResourceRef(matched).urn,
		secret_token: matched?.secret_token || null,
		title: matched.title || answers.name
	};
	
	if (!payload.key) {
		throw new Error("Не удалось определить идентификатор плейлиста.");
	}
	
	const fileName = `${answers.name}.json`;
	const path = resolveRel("data", "playlists", fileName);
	
	writeJson(path, payload);
	log.info(`Плейлист сохранён: ${fileName}`);
	
	return payload;
}

function chooseNextPlaylistTitle(baseTitle, partNumber) {
	if (!partNumber || partNumber <= 1) return baseTitle;
	return `${baseTitle} ${partNumber}`;
}

function savePlaylistProfileFile(profile, partNumber) {
	const suffix = partNumber > 1 ? `-${partNumber}` : "";
	const fileName = `${slugifyFilePart(profile.name, "playlist")}${suffix}.json`;
	const path = resolveRel("data", "playlists", fileName);
	
	writeJson(path, {
		name: profile.name,
		url: profile.url,
		title: profile.title,
		key: profile.key,
		id: profile.id,
		urn: profile.urn,
		secret_token: profile.secret_token
	});
	
	return fileName;
}

function ensureRootPlaylistState(playlistsState, playlistProfile) {
	const rootKey = playlistProfile.name;
	
	if (!playlistsState.roots || typeof playlistsState.roots !== "object") {
		playlistsState.roots = {};
	}
	
	if (!playlistsState.roots[rootKey]) {
		playlistsState.roots[rootKey] = normalizePlaylistRootState(null, playlistProfile);
	}
	
	const rootState = normalizePlaylistRootState(playlistsState.roots[rootKey], playlistProfile);
	playlistsState.roots[rootKey] = rootState;
	
	for (const partNo of Object.keys(rootState.parts)) {
		const part = rootState.parts[partNo];
		const stateKey = part?.id || part?.key;
		if (!stateKey) continue;
		
		if (!playlistsState.playlists[stateKey]) {
			playlistsState.playlists[stateKey] = {
				added_ids: {},
				title: part.title || rootState.base_title,
				url: part.url || rootState.base_url,
				part: Number(partNo)
			};
		}
	}
	
	return rootState;
}

async function activatePlaylistPart(sc, playlistsState, rootState, partNumber, fallbackProfile) {
	const existingPart = rootState.parts[String(partNumber)];
	
	if (existingPart?.key || existingPart?.id || existingPart?.urn) {
		rootState.active_part = partNumber;
		rootState.active_playlist_key = existingPart.key || existingPart.urn || existingPart.id || null;
		rootState.active_playlist_id = existingPart.id || null;
		savePlaylistsState(playlistsState);
		
		return {
			name: fallbackProfile.name,
			url: existingPart.url || fallbackProfile.url || null,
			title: existingPart.title || chooseNextPlaylistTitle(rootState.base_title, partNumber),
			key: existingPart.key || existingPart.urn || existingPart.id,
			id: existingPart.id || null,
			urn: existingPart.urn || null,
			secret_token: existingPart.secret_token || null
		};
	}
	
	const title = chooseNextPlaylistTitle(rootState.base_title, partNumber);
	log.info(`Создаю новый плейлист автоматически: ${title}`);
	
	const created = await sc.createPlaylist({
		title,
		description: "",
		sharing: "private",
		tracks: []
	});
	
	const profile = {
		name: fallbackProfile.name,
		url: created?.permalink_url || null,
		title: created?.title || title,
		key: safeResourceKey(created),
		id: safeNumericId(created),
		urn: safeResourceRef(created).urn,
		secret_token: created?.secret_token || null
	};
	
	if (!profile.key) {
		throw new Error(`Не удалось определить идентификатор нового плейлиста: ${title}`);
	}
	
	const fileName = savePlaylistProfileFile(profile, partNumber);
	
	rootState.parts[String(partNumber)] = {
		key: profile.key,
		id: profile.id,
		urn: profile.urn,
		title: profile.title,
		url: profile.url,
		secret_token: profile.secret_token,
		file_name: fileName
	};
	rootState.active_part = partNumber;
	rootState.active_playlist_key = profile.key;
	rootState.active_playlist_id = profile.id || null;
	
	const stateKey = profile.id || profile.key;
	if (!playlistsState.playlists[stateKey]) {
		playlistsState.playlists[stateKey] = {
			added_ids: {},
			title: profile.title,
			url: profile.url,
			part: partNumber
		};
	}
	
	savePlaylistsState(playlistsState);
	log.info(`Новый плейлист создан и сохранён в конфиг: ${fileName}`);
	
	return profile;
}

async function ensureWritablePlaylist(sc, playlistsState, rootState, currentProfile) {
	let activePart = rootState.active_part || 1;
	let profile = await activatePlaylistPart(sc, playlistsState, rootState, activePart, currentProfile);
	let playlist = await sc.getPlaylist(profile.key);
	
	while ((Array.isArray(playlist?.tracks) ? playlist.tracks.length : 0) >= PLAYLIST_TRACK_LIMIT) {
		activePart += 1;
		profile = await activatePlaylistPart(sc, playlistsState, rootState, activePart, currentProfile);
		playlist = await sc.getPlaylist(profile.key);
	}
	
	return { profile, playlist };
}

async function chooseSearchMode(tracksHash) {
	const cached = readJson(FOUND_PATH, null);
	const cacheValid = cached?.tracks_hash === tracksHash && Array.isArray(cached?.found) && cached.found.length > 0;
	
	const searchState = readJson(STATE_SEARCH_PATH, null);
	const canResume =
		searchState?.tracks_hash === tracksHash &&
		Number.isFinite(searchState?.next_index) &&
		searchState.next_index > 0 &&
		searchState.next_index < (searchState.total || Number.MAX_SAFE_INTEGER);
	
	const choices = [];
	if (cacheValid) choices.push({ name: `Использовать кэш найденных (${cached.found.length})`, value: "use_cache" });
	if (canResume) choices.push({ name: `Продолжить обработку с места остановки (строка ${searchState.next_index + 1})`, value: "resume" });
	choices.push({ name: "Обработать файл заново с нуля (сбросить кэш/прогресс поиска)", value: "fresh" });
	
	const { mode } = await inquirer.prompt([
		{ type: "list", name: "mode", message: "Режим обработки tracks.txt:", choices }
	]);
	
	return mode;
}

function loadSearchState() {
	return readJson(STATE_SEARCH_PATH, { tracks_hash: null, next_index: 0, total: 0, updated_at: null });
}

function resetSearchProgress(tracksHash, totalLines) {
	writeJson(STATE_SEARCH_PATH, {
		tracks_hash: tracksHash,
		next_index: 0,
		total: totalLines,
		updated_at: new Date().toISOString()
	});
	
	writeJson(FOUND_PATH, {
		generated_at: new Date().toISOString(),
		tracks_hash: tracksHash,
		found: []
	});
}

function saveSearchState(st) {
	st.updated_at = new Date().toISOString();
	writeJson(STATE_SEARCH_PATH, st);
}

function loadFoundCache() {
	return readJson(FOUND_PATH, { generated_at: null, tracks_hash: null, found: [] });
}

function saveFoundCache(cache) {
	cache.generated_at = new Date().toISOString();
	writeJson(FOUND_PATH, cache);
}

function loadLikesState() {
	return readJson(STATE_LIKES_PATH, { liked_ids: {}, updated_at: null });
}

function saveLikesState(st) {
	st.updated_at = new Date().toISOString();
	writeJson(STATE_LIKES_PATH, st);
}

function loadPlaylistsState() {
	const base = readJson(STATE_PLAYLISTS_PATH, { playlists: {}, roots: {}, updated_at: null });
	return {
		playlists: base?.playlists && typeof base.playlists === "object" ? base.playlists : {},
		roots: base?.roots && typeof base.roots === "object" ? base.roots : {},
		updated_at: base?.updated_at ?? null
	};
}

function savePlaylistsState(st) {
	st.updated_at = new Date().toISOString();
	writeJson(STATE_PLAYLISTS_PATH, st);
}

async function parseTracks(sc, tracksLines, tracksHash, stats) {
	const spinner = ora({ text: "Подготовка поиска...", spinner: "dots" }).start();
	
	stats.search.total_lines = tracksLines.length;
	stats.search.parsed_lines = tracksLines.length;
	stats.search.errors = 0;
	stats.search.stopped_by_429 = false;
	stats.search.finished = false;
	saveStats(stats);
	
	const searchState = loadSearchState();
	let startIndex = 0;
	
	if (searchState.tracks_hash === tracksHash && Number.isFinite(searchState.next_index)) {
		startIndex = searchState.next_index;
	} else {
		searchState.tracks_hash = tracksHash;
		searchState.next_index = 0;
		searchState.total = tracksLines.length;
		saveSearchState(searchState);
	}
	
	const cache = loadFoundCache();
	if (cache.tracks_hash !== tracksHash) {
		cache.tracks_hash = tracksHash;
		cache.found = [];
		saveFoundCache(cache);
	}
	
	spinner.stop();
	log.info(`Поиск: старт с позиции ${startIndex + 1}/${tracksLines.length}`);
	stats.search.started_from = startIndex + 1;
	saveStats(stats);
	
	const bar = new cliProgress.SingleBar(
		{
			format: `${chalk.cyan("{bar}")} {percentage}% | {value}/{total} | {line}`,
			barCompleteChar: "█",
			barIncompleteChar: "░",
			hideCursor: true
		},
		cliProgress.Presets.shades_classic
	);
	
	bar.start(tracksLines.length, startIndex, { line: "" });
	
	for (let i = startIndex; i < tracksLines.length; i++) {
		const line = tracksLines[i];
		bar.update(i + 1, { line: line.length > 42 ? line.slice(0, 39) + "..." : line });
		
		const parsed = parseLine(line);
		if (!parsed) {
			appendText(NOT_FOUND_PATH, line);
			stats.search.not_found += 1;
			stats.search.last_index = i + 1;
			saveStats(stats);
			
			searchState.next_index = i + 1;
			saveSearchState(searchState);
			continue;
		}
		
		const q = `${parsed.artist} ${parsed.title}`;
		
		try {
			const results = await sc.searchTracks({ q, limit: SEARCH_LIMIT });
			
			if (!results.length) {
				appendText(NOT_FOUND_PATH, line);
				stats.search.not_found += 1;
			} else {
				const best = pickBestMatch(parsed, results);
				
				if (!best) {
					appendText(NOT_FOUND_PATH, line);
					stats.search.not_found += 1;
				} else {
					const trackKey = safeResourceKey(best);
					
					if (trackKey) {
						cache.found.push({
							source_line: line,
							query: q,
							track: {
								key: trackKey,
								id: best.id ?? null,
								urn: best.urn ?? null,
								title: best.title,
								permalink_url: best.permalink_url,
								user: { username: best.user?.username || "" }
							}
						});
						saveFoundCache(cache);
						stats.search.found += 1;
					} else {
						appendText(NOT_FOUND_PATH, line);
						stats.search.not_found += 1;
					}
				}
			}
			
			searchState.next_index = i + 1;
			searchState.total = tracksLines.length;
			saveSearchState(searchState);
			
			stats.search.last_index = i + 1;
			saveStats(stats);
			
			await sleep(SEARCH_DELAY_MS);
		} catch (e) {
			const status = e?.response?.status;
			const payload = e?.response?.data;
			
			stats.search.errors += 1;
			stats.search.last_index = i + 1;
			saveStats(stats);
			
			bar.stop();
			log.error(`Ошибка при поиске на строке ${i + 1}: ${line}`, payload || e?.message);
			
			if (status === 429) {
				log.warn("Получен 429 при поиске. Останавливаю работу с сохранением прогресса.");
				stats.search.stopped_by_429 = true;
				saveStats(stats);
				return { stoppedBy429: true, cache: loadFoundCache() };
			}
			
			if (status === 401 || /не авторизован/i.test(String(e?.message || ""))) {
				throw new Error("Сессия истекла во время поиска. Токен обновлён не был.");
			}
			
			bar.start(tracksLines.length, i + 1, { line: "" });
			await sleep(1000);
		}
	}
	
	bar.stop();
	stats.search.finished = true;
	saveStats(stats);
	
	log.info("Поиск завершен.");
	return { stoppedBy429: false, cache: loadFoundCache() };
}

async function likeFlow(sc, foundCache, stats) {
	const likesState = loadLikesState();
	
	stats.likes.total_found = foundCache.found.length;
	stats.likes.processed = 0;
	stats.likes.liked = 0;
	stats.likes.already_liked = 0;
	stats.likes.skipped_by_state = 0;
	stats.likes.errors = 0;
	stats.likes.finished = false;
	stats.likes.stopped_by_429 = false;
	saveStats(stats);
	
	log.info(
		`Лайки: найдено ${stats.likes.total_found}, ` +
		`обработано ${stats.likes.processed}, ` +
		`не найдено ${stats.search.not_found}, ` +
		`ошибок ${stats.likes.errors + stats.search.errors}, ` +
		`уже обработано (state) ${Object.keys(likesState.liked_ids || {}).length}.`
	);
	
	const bar = new cliProgress.SingleBar(
		{
			format: `${chalk.green("{bar}")} {percentage}% | {value}/{total} | {title}`,
			barCompleteChar: "█",
			barIncompleteChar: "░",
			hideCursor: true
		},
		cliProgress.Presets.shades_classic
	);
	
	bar.start(foundCache.found.length, 0, { title: "" });
	
	for (let i = 0; i < foundCache.found.length; i++) {
		const item = foundCache.found[i];
		const trackKey = safeResourceKey(item?.track);
		const title = item?.track?.title || item?.source_line || "track";
		
		bar.update(i + 1, { title: title.length > 42 ? title.slice(0, 39) + "..." : title });
		
		if (!trackKey) continue;
		
		if (likesState.liked_ids[trackKey]) {
			stats.likes.skipped_by_state += 1;
			stats.likes.processed += 1;
			stats.likes.last_index = i + 1;
			saveStats(stats);
			continue;
		}
		
		try {
			const liked = await sc.isTrackLikedBestEffort(trackKey);
			if (liked === true) {
				likesState.liked_ids[trackKey] = { at: new Date().toISOString(), status: "already-liked" };
				saveLikesState(likesState);
				
				stats.likes.already_liked += 1;
				stats.likes.processed += 1;
				stats.likes.last_index = i + 1;
				saveStats(stats);
				continue;
			}
			
			await sc.likeTrack(trackKey);
			
			likesState.liked_ids[trackKey] = { at: new Date().toISOString(), status: "liked" };
			saveLikesState(likesState);
			
			stats.likes.liked += 1;
			stats.likes.processed += 1;
			stats.likes.last_index = i + 1;
			saveStats(stats);
			
			await sleep(getLikeDelayMs());
		} catch (e) {
			const status = e?.response?.status;
			const payload = e?.response?.data;
			
			stats.likes.errors += 1;
			stats.likes.last_index = i + 1;
			saveStats(stats);
			
			bar.stop();
			
			if (status === 429) {
				log.error("Получен 429 при лайке. Немедленная остановка. Прогресс сохранен.", payload || e?.message);
				stats.likes.stopped_by_429 = true;
				saveStats(stats);
				return { stoppedBy429: true };
			}
			
			if (status === 409) {
				likesState.liked_ids[trackKey] = { at: new Date().toISOString(), status: "already-liked" };
				saveLikesState(likesState);
				
				stats.likes.already_liked += 1;
				stats.likes.processed += 1;
				saveStats(stats);
				
				bar.start(foundCache.found.length, i + 1, { title: "" });
				continue;
			}
			
			if (status === 401 || /не авторизован/i.test(String(e?.message || ""))) {
				throw new Error("Сессия истекла во время лайков. Операция остановлена.");
			}
			
			log.error(`Ошибка лайка (id=${trackKey}, title="${title}")`, payload || e?.message);
			
			bar.start(foundCache.found.length, i + 1, { title: "" });
			await sleep(1200);
		}
	}
	
	bar.stop();
	stats.likes.finished = true;
	saveStats(stats);
	
	log.info("Лайкинг завершен.");
	return { stoppedBy429: false };
}

function playlistContainsTrack(playlist, trackRef) {
	const wantedId = safeNumericId(trackRef);
	const wantedKey = safeResourceKey(trackRef);
	
	const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
	for (const t of tracks) {
		const existingId = safeNumericId(t);
		const existingKey = safeResourceKey(t);
		
		if (wantedId && existingId && wantedId === existingId) return true;
		if (wantedKey && existingKey && wantedKey === existingKey) return true;
	}
	
	return false;
}

async function playlistFlow(sc, playlistProfile, foundCache, stats) {
	if (!playlistProfile) {
		throw new Error("Не удалось инициализировать профиль плейлиста.");
	}
	
	const playlistsState = loadPlaylistsState();
	const rootState = ensureRootPlaylistState(playlistsState, playlistProfile);
	savePlaylistsState(playlistsState);
	
	stats.playlist.total_found = foundCache.found.length;
	stats.playlist.processed = 0;
	stats.playlist.added = 0;
	stats.playlist.already_in_playlist = 0;
	stats.playlist.skipped_by_state = 0;
	stats.playlist.errors = 0;
	stats.playlist.finished = false;
	stats.playlist.stopped_by_429 = false;
	stats.playlist.last_index = 0;
	stats.playlist.target_title = playlistProfile.title || null;
	stats.playlist.target_url = playlistProfile.url || null;
	stats.playlist.target_part = rootState.active_part || 1;
	saveStats(stats);
	
	let writable = await ensureWritablePlaylist(sc, playlistsState, rootState, playlistProfile);
	let currentProfile = writable.profile;
	let playlist = writable.playlist;
	
	stats.playlist.target_title = currentProfile.title || null;
	stats.playlist.target_url = currentProfile.url || null;
	stats.playlist.target_part = rootState.active_part || 1;
	saveStats(stats);
	
	log.info(`Активный плейлист для записи: ${currentProfile.title}`);
	
	let currentPlaylistStateKey = currentProfile.id || currentProfile.key;
	if (!playlistsState.playlists[currentPlaylistStateKey]) {
		playlistsState.playlists[currentPlaylistStateKey] = {
			added_ids: {},
			title: currentProfile.title || currentProfile.name || "playlist",
			url: currentProfile.url || null,
			part: rootState.active_part || 1
		};
		savePlaylistsState(playlistsState);
	}
	
	let existingTracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
	let existingSet = new Set(
		existingTracks
		.map((t) => safeNumericId(t) || safeResourceKey(t))
		.filter(Boolean)
	);
	
	let playlistTracks = existingTracks
	.map((t) => ({
		id: safeNumericId(t) ? Number(safeNumericId(t)) : null,
		urn: safeResourceRef(t).urn || null
	}))
	.filter((t) => t.id || t.urn);
	
	log.info(
		`Плейлист "${currentProfile.title}": ` +
		`уже внутри ${existingSet.size} треков, ` +
		`к обработке найдено ${foundCache.found.length}.`
	);
	
	const bar = new cliProgress.SingleBar(
		{
			format: `${chalk.magenta("{bar}")} {percentage}% | {value}/{total} | {title}`,
			barCompleteChar: "█",
			barIncompleteChar: "░",
			hideCursor: true
		},
		cliProgress.Presets.shades_classic
	);
	
	bar.start(foundCache.found.length, 0, { title: "" });
	
	for (let i = 0; i < foundCache.found.length; i++) {
		const item = foundCache.found[i];
		const trackKey = safeNumericId(item?.track) || safeResourceKey(item?.track);
		const title = item?.track?.title || item?.source_line || "track";
		
		bar.update(i + 1, { title: title.length > 42 ? title.slice(0, 39) + "..." : title });
		
		if (!trackKey) continue;
		
		currentPlaylistStateKey = currentProfile.id || currentProfile.key;
		if (!playlistsState.playlists[currentPlaylistStateKey]) {
			playlistsState.playlists[currentPlaylistStateKey] = {
				added_ids: {},
				title: currentProfile.title || currentProfile.name || "playlist",
				url: currentProfile.url || null,
				part: rootState.active_part || 1
			};
			savePlaylistsState(playlistsState);
		}
		
		const playlistState = playlistsState.playlists[currentPlaylistStateKey];
		
		if (playlistState.added_ids[trackKey]) {
			stats.playlist.skipped_by_state += 1;
			stats.playlist.processed += 1;
			stats.playlist.last_index = i + 1;
			saveStats(stats);
			continue;
		}
		
		if (existingSet.has(trackKey)) {
			playlistState.added_ids[trackKey] = {
				at: new Date().toISOString(),
				status: "already-in-playlist"
			};
			savePlaylistsState(playlistsState);
			
			stats.playlist.already_in_playlist += 1;
			stats.playlist.processed += 1;
			stats.playlist.last_index = i + 1;
			saveStats(stats);
			continue;
		}
		
		try {
			if (playlistTracks.length >= PLAYLIST_TRACK_LIMIT) {
				bar.stop();
				log.info(`Достигнут лимит ${PLAYLIST_TRACK_LIMIT} треков. Переключаюсь на следующий плейлист...`);
				
				writable = await ensureWritablePlaylist(sc, playlistsState, rootState, {
					...playlistProfile,
					...currentProfile
				});
				currentProfile = writable.profile;
				playlist = writable.playlist;
				
				stats.playlist.target_title = currentProfile.title || null;
				stats.playlist.target_url = currentProfile.url || null;
				stats.playlist.target_part = rootState.active_part || 1;
				saveStats(stats);
				
				existingTracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
				existingSet = new Set(
					existingTracks
					.map((t) => safeNumericId(t) || safeResourceKey(t))
					.filter(Boolean)
				);
				playlistTracks = existingTracks
				.map((t) => ({
					id: safeNumericId(t) ? Number(safeNumericId(t)) : null,
					urn: safeResourceRef(t).urn || null
				}))
				.filter((t) => t.id || t.urn);
				
				log.info(`Продолжаю запись в плейлист: ${currentProfile.title}`);
				bar.start(foundCache.found.length, i + 1, { title: "" });
			}
			
			const trackIdNum = safeNumericId(item?.track);
			const trackUrn = safeResourceRef(item?.track).urn || null;
			
			if (!trackIdNum && !trackUrn) {
				throw new Error(`Некорректный track ref: ${trackKey}`);
			}
			
			playlistTracks.push({
				id: trackIdNum ? Number(trackIdNum) : null,
				urn: trackUrn
			});
			
			await sc.updatePlaylistTracks(currentProfile.key, playlistTracks, {
				secretToken: currentProfile.secret_token || null
			});
			
			playlist = await sc.getPlaylist(currentProfile.key);
			if (!playlistContainsTrack(playlist, item?.track)) {
				playlistTracks.pop();
				throw new Error(
					`SoundCloud принял запрос, но трек не появился в плейлисте после повторной проверки (track=${trackKey}).`
				);
			}
			
			existingSet.add(trackKey);
			playlistState.added_ids[trackKey] = {
				at: new Date().toISOString(),
				status: "added"
			};
			savePlaylistsState(playlistsState);
			
			stats.playlist.added += 1;
			stats.playlist.processed += 1;
			stats.playlist.last_index = i + 1;
			stats.playlist.target_title = currentProfile.title || null;
			stats.playlist.target_url = currentProfile.url || null;
			stats.playlist.target_part = rootState.active_part || 1;
			saveStats(stats);
			
			await sleep(1200);
		} catch (e) {
			const status = e?.response?.status;
			const payload = e?.response?.data;
			
			stats.playlist.errors += 1;
			stats.playlist.last_index = i + 1;
			saveStats(stats);
			
			bar.stop();
			
			if (status === 429) {
				log.error("Получен 429 при добавлении в плейлист. Немедленная остановка. Прогресс сохранён.", payload || e?.message);
				stats.playlist.stopped_by_429 = true;
				saveStats(stats);
				return { stoppedBy429: true };
			}
			
			if (status === 401 || /не авторизован/i.test(String(e?.message || ""))) {
				throw new Error("Сессия истекла во время добавления в плейлист. Операция остановлена.");
			}
			
			if (status === 422 && playlistTracks.length >= PLAYLIST_TRACK_LIMIT) {
				log.warn(`Получен 422 на заполненном плейлисте "${currentProfile.title}". Переключение на новый плейлист.`);
				if (playlistTracks.length) {
					playlistTracks.pop();
				}
				
				writable = await ensureWritablePlaylist(sc, playlistsState, rootState, {
					...playlistProfile,
					...currentProfile,
					key: null,
					id: null,
					urn: null
				});
				currentProfile = writable.profile;
				playlist = writable.playlist;
				
				existingTracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
				existingSet = new Set(
					existingTracks
					.map((t) => safeNumericId(t) || safeResourceKey(t))
					.filter(Boolean)
				);
				playlistTracks = existingTracks
				.map((t) => ({
					id: safeNumericId(t) ? Number(safeNumericId(t)) : null,
					urn: safeResourceRef(t).urn || null
				}))
				.filter((t) => t.id || t.urn);
				
				stats.playlist.target_title = currentProfile.title || null;
				stats.playlist.target_url = currentProfile.url || null;
				stats.playlist.target_part = rootState.active_part || 1;
				saveStats(stats);
				
				bar.start(foundCache.found.length, i, { title: "" });
				continue;
			}
			
			if (playlistTracks.length) {
				playlistTracks.pop();
			}
			
			log.error(`Ошибка добавления в плейлист (track=${trackKey}, title="${title}")`, payload || e?.message);
			
			bar.start(foundCache.found.length, i + 1, { title: "" });
			await sleep(1200);
		}
	}
	
	bar.stop();
	console.log("");
	stats.playlist.finished = true;
	saveStats(stats);
	
	log.info(
		`Добавление в плейлист завершено. ` +
		`Добавлено: ${stats.playlist.added}, ` +
		`уже были в плейлисте: ${stats.playlist.already_in_playlist}, ` +
		`пропущено по state: ${stats.playlist.skipped_by_state}, ` +
		`ошибок: ${stats.playlist.errors}.`
	);
	
	return { stoppedBy429: false };
}

async function main() {
	initLogFiles();
	initFiles();
	const stats = initStats();
	
	clearConsole();
	header();
	
	if (!exists(TRACKS_TXT)) {
		log.error(`Файл tracks.txt не найден: ${TRACKS_TXT}`);
		process.exit(1);
	}
	
	const cfg = await selectOrCreateConfig();
	let tokens = await getValidTokens(cfg);
	
	const sc = new SoundCloudClient({
		accessToken: tokens.access_token,
		clientId: cfg.client_id,
		onUnauthorized: async () => {
			const fresh = await getValidTokens(cfg, true);
			tokens = fresh;
			return fresh;
		},
		logger: log
	});
	
	const spinner = ora({ text: "Проверка авторизации...", spinner: "dots" }).start();
	const me = await sc.me();
	spinner.stop();
	
	const username = me?.username || me?.full_name || String(me?.id || "");
	log.info(`Авторизован пользователь SoundCloud: ${username}`);
	
	const actionMode = await selectActionMode();
	
	let playlistProfile = null;
	if (actionMode === "playlist") {
		playlistProfile = buildAutoPlaylistProfile();
		log.info(
			`Режим авто-плейлистов: создаю новую серию плейлистов "${playlistProfile.title}" ` +
			`с лимитом ${PLAYLIST_TRACK_LIMIT} треков на плейлист.`
		);
	}
	
	const tracksHash = sha256File(TRACKS_TXT);
	const lines = readTextLines(TRACKS_TXT);
	
	stats.search.found = 0;
	stats.search.not_found = 0;
	stats.search.errors = 0;
	saveStats(stats);
	
	const mode = await chooseSearchMode(tracksHash);
	
	let foundCache = loadFoundCache();
	
	if (mode === "use_cache") {
		log.info("Использую кэш найденных треков (поиск не выполняется).");
		stats.search.total_lines = lines.length;
		stats.search.parsed_lines = lines.length;
		stats.search.found = foundCache.found.length;
		saveStats(stats);
	} else {
		if (mode === "fresh") {
			log.warn("Сбрасываю прогресс поиска и кэш найденных. Начинаю с нуля.");
			resetSearchProgress(tracksHash, lines.length);
		} else {
			log.info("Продолжаю обработку с места остановки.");
		}
		
		const res = await parseTracks(sc, lines, tracksHash, stats);
		foundCache = res.cache;
		
		if (res.stoppedBy429) {
			log.warn("Работа остановлена из-за 429 на этапе поиска. Запусти позже — продолжит с места.");
			return;
		}
	}
	
	stats.search.found = foundCache.found.length;
	saveStats(stats);
	
	if (actionMode === "like") {
		const likeRes = await likeFlow(sc, foundCache, stats);
		
		if (likeRes.stoppedBy429) {
			log.warn("Работа остановлена из-за 429 на этапе лайков. Запусти позже — продолжит с места.");
			return;
		}
	} else {
		const playlistRes = await playlistFlow(sc, playlistProfile, foundCache, stats);
		
		if (playlistRes.stoppedBy429) {
			log.warn("Работа остановлена из-за 429 на этапе добавления в плейлист. Запусти позже — продолжит с места.");
			return;
		}
	}
	
	log.info("Готово.");
}

main().catch((e) => {
	const payload = e?.response?.data;
	log.error("Фатальная ошибка.", payload || e?.message || e);
	process.exit(1);
});
