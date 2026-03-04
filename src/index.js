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
	sha256File
} from "./store.js";
import { makeLogger } from "./logger.js";
import { exchangeTokenAuthCode, refreshToken, makePkce } from "./oauth.js";

/**
 * SC Like — elecktro1337 (t.me/elecktro1337)
 */

const APP_NAME = "SC Like";
const APP_AUTHOR = "elecktro1337 (t.me/elecktro1337)";

const DATA_DIR = resolveRel("data");
const CONFIGS_DIR = resolveRel("data", "configs");
const TOKENS_PATH = resolveRel("data", "tokens.json");
const FOUND_PATH = resolveRel("data", "found_tracks.json");
const NOT_FOUND_PATH = resolveRel("data", "not_found.txt");
const STATE_SEARCH_PATH = resolveRel("data", "state_search.json");
const STATE_LIKES_PATH = resolveRel("data", "state_likes.json");
const ERRORS_LOG_PATH = resolveRel("data", "errors.log");
const TRACKS_TXT = resolveRel("tracks.txt");

const LIKE_DELAY_MS = 2500; // безопасно медленно (антифрод у SC часто агрессивный)
const SEARCH_DELAY_MS = 200; // минимальная пауза между поисками (чтобы не молотить API)
const SEARCH_LIMIT = 30;

const log = makeLogger({ errorsLogPath: ERRORS_LOG_PATH });

function clearConsole() {
	process.stdout.write("\x1Bc");
}

function header() {
	const art = figlet.textSync("SC Like", { horizontalLayout: "default" });
	console.log(chalk.green(art));
	console.log(chalk.gray(`Автор: ${APP_AUTHOR}`));
	console.log(chalk.gray("Назначение: поиск треков из tracks.txt и проставление лайков с возобновлением.\n"));
	console.log(chalk.gray("Кратко:"));
	console.log(chalk.gray("1) Подготовь tracks.txt (Artist - Title)"));
	console.log(chalk.gray("2) Запусти программу, выбери конфиг, выбери кэш/перепарс"));
	console.log(chalk.gray("3) Программа найдет треки, затем начнет лайкать\n"));
}

function nowSec() {
	return Math.floor(Date.now() / 1000);
}

function safeId(x) {
	const n = Number(x);
	return Number.isFinite(n) ? n : null;
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

async function getValidTokens(cfg) {
	const tok = readJson(TOKENS_PATH, null);
	
	if (tok?.access_token && tok?.expires_at && tok.expires_at - nowSec() > 60) return tok;
	
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
	
	// Полный OAuth (Authorization Code + PKCE)
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
	
	if (!exists(FOUND_PATH)) {
		writeJson(FOUND_PATH, { generated_at: null, tracks_hash: null, found: [] });
	}
	if (!exists(STATE_SEARCH_PATH)) {
		writeJson(STATE_SEARCH_PATH, { tracks_hash: null, next_index: 0, total: 0, updated_at: null });
	}
	if (!exists(STATE_LIKES_PATH)) {
		writeJson(STATE_LIKES_PATH, { liked_ids: {}, updated_at: null });
	}
	if (!exists(NOT_FOUND_PATH)) {
		appendText(NOT_FOUND_PATH, "# not found (Artist - Title) — appended");
	}
}

async function chooseCacheMode(tracksHash) {
	const hasCache = exists(FOUND_PATH);
	const cached = readJson(FOUND_PATH, null);
	const cacheValid = hasCache && cached?.tracks_hash === tracksHash && Array.isArray(cached?.found);
	
	const choices = [];
	if (cacheValid && cached.found.length > 0) {
		choices.push({ name: `Использовать кэш найденных (${cached.found.length} треков)`, value: "use_cache" });
	}
	choices.push({ name: "Заново обработать tracks.txt (с возобновлением при падении)", value: "reparse" });
	
	const { mode } = await inquirer.prompt([
		{ type: "list", name: "mode", message: "Поиск треков:", choices }
	]);
	
	return mode;
}

function loadSearchState() {
	return readJson(STATE_SEARCH_PATH, { tracks_hash: null, next_index: 0, total: 0, updated_at: null });
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

async function parseTracks(sc, tracksLines, tracksHash) {
	const spinner = ora({ text: "Подготовка поиска...", spinner: "dots" }).start();
	
	const searchState = loadSearchState();
	let startIndex = 0;
	
	// если это тот же tracks.txt, продолжаем
	if (searchState.tracks_hash === tracksHash && Number.isFinite(searchState.next_index)) {
		startIndex = searchState.next_index;
	} else {
		// новый список — сбрасываем прогресс поиска
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
			searchState.next_index = i + 1;
			saveSearchState(searchState);
			continue;
		}
		
		const q = `${parsed.artist} ${parsed.title}`;
		
		try {
			const results = await sc.searchTracks({ q, limit: SEARCH_LIMIT });
			
			if (!results.length) {
				appendText(NOT_FOUND_PATH, line);
			} else {
				const best = pickBestMatch(parsed, results);
				if (!best) {
					appendText(NOT_FOUND_PATH, line);
				} else {
					const id = safeId(best.id);
					if (id) {
						cache.found.push({
							source_line: line,
							query: q,
							track: {
								id,
								title: best.title,
								permalink_url: best.permalink_url,
								user: { username: best.user?.username || "" }
							}
						});
						// сохраняем инкрементально (чтобы при падении не потерять)
						saveFoundCache(cache);
					} else {
						appendText(NOT_FOUND_PATH, line);
					}
				}
			}
			
			// прогресс поиска
			searchState.next_index = i + 1;
			searchState.total = tracksLines.length;
			saveSearchState(searchState);
			
			await sleep(SEARCH_DELAY_MS);
		} catch (e) {
			const status = e?.response?.status;
			const payload = e?.response?.data;
			
			log.error(`Ошибка при поиске на строке ${i + 1}: ${line}`, payload || e?.message);
			
			// Если внезапно прилетает 429 на поиске — стоп, сохранили всё что есть
			if (status === 429) {
				log.warn("Получен 429 при поиске. Останавливаю работу с сохранением прогресса.");
				bar.stop();
				return { stoppedBy429: true, cache: loadFoundCache() };
			}
			
			// иначе продолжаем (можно сделать иначе, но так практичнее)
			await sleep(1000);
		}
	}
	
	bar.stop();
	log.info("Поиск завершен.");
	return { stoppedBy429: false, cache: loadFoundCache() };
}

async function likeFlow(sc, foundCache) {
	const likesState = loadLikesState();
	
	log.info(`Лайки: к обработке ${foundCache.found.length} треков.`);
	
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
		const id = safeId(item?.track?.id);
		const title = item?.track?.title || item?.source_line || "track";
		
		bar.update(i + 1, { title: title.length > 42 ? title.slice(0, 39) + "..." : title });
		
		if (!id) continue;
		
		// локальный кеш лайков: пропускаем, если уже обработано
		if (likesState.liked_ids[String(id)]) continue;
		
		try {
			// best-effort проверка на лайк ДО лайка
			// если null — неизвестно, идём дальше
			const liked = await sc.isTrackLikedBestEffort(id);
			if (liked === true) {
				likesState.liked_ids[String(id)] = { at: new Date().toISOString(), status: "already-liked" };
				saveLikesState(likesState);
				continue;
			}
			
			// ставим лайк
			await sc.likeTrack(id);
			
			likesState.liked_ids[String(id)] = { at: new Date().toISOString(), status: "liked" };
			saveLikesState(likesState);
			
			await sleep(LIKE_DELAY_MS);
		} catch (e) {
			const status = e?.response?.status;
			const payload = e?.response?.data;
			
			// если 429 — немедленно стоп
			if (status === 429) {
				log.error("Получен 429 при лайке. Немедленная остановка. Прогресс сохранен.", payload || e?.message);
				bar.stop();
				return { stoppedBy429: true };
			}
			
			// “already liked” иногда может приходить не через check, а как 409/400
			if (status === 409) {
				likesState.liked_ids[String(id)] = { at: new Date().toISOString(), status: "already-liked" };
				saveLikesState(likesState);
				continue;
			}
			
			log.error(`Ошибка лайка (id=${id}, title="${title}")`, payload || e?.message);
			
			// сохраняем и продолжаем (кроме 429)
			await sleep(1200);
		}
	}
	
	bar.stop();
	log.info("Лайкинг завершен.");
	return { stoppedBy429: false };
}

async function main() {
	initFiles();
	clearConsole();
	header();
	
	// базовые проверки
	if (!exists(TRACKS_TXT)) {
		log.error(`Файл tracks.txt не найден: ${TRACKS_TXT}`);
		process.exit(1);
	}
	
	const cfg = await selectOrCreateConfig();
	const tokens = await getValidTokens(cfg);
	
	const sc = new SoundCloudClient({ accessToken: tokens.access_token });
	
	const spinner = ora({ text: "Проверка авторизации...", spinner: "dots" }).start();
	const me = await sc.me();
	spinner.stop();
	
	const username = me?.username || me?.full_name || String(me?.id || "");
	log.info(`Авторизован пользователь SoundCloud: ${username}`);
	
	const tracksHash = sha256File(TRACKS_TXT);
	const lines = readTextLines(TRACKS_TXT);
	
	const mode = await chooseCacheMode(tracksHash);
	
	let foundCache = loadFoundCache();
	
	// 1) Парсинг (всегда перед лайком; но можно использовать кэш)
	if (mode === "use_cache") {
		log.info("Использую кэш найденных треков.");
	} else {
		const res = await parseTracks(sc, lines, tracksHash);
		foundCache = res.cache;
		
		if (res.stoppedBy429) {
			log.warn("Работа остановлена из-за 429 на этапе поиска. Запусти позже — продолжит с места.");
			return;
		}
	}
	
	// 2) Лайкинг
	const likeRes = await likeFlow(sc, foundCache);
	
	if (likeRes.stoppedBy429) {
		log.warn("Работа остановлена из-за 429 на этапе лайков. Запусти позже — продолжит с места.");
		return;
	}
	
	log.info("Готово.");
}

main().catch((e) => {
	const payload = e?.response?.data;
	log.error("Фатальная ошибка.", payload || e?.message || e);
	process.exit(1);
});