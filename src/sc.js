import axios from "axios";

function normalizeCollection(data) {
	if (Array.isArray(data)) return data;
	if (data && Array.isArray(data.collection)) return data.collection;
	return [];
}

function normalizeUrl(url) {
	if (!url || typeof url !== "string") return "";
	return url
	.trim()
	.replace(/^http:\/\//i, "https://")
	.replace(/\/+$/, "")
	.toLowerCase();
}

function safeUrlPath(url) {
	try {
		const u = new URL(url);
		return u.pathname.replace(/\/+$/, "").toLowerCase();
	} catch {
		return "";
	}
}

function asTrimmedString(v) {
	if (typeof v !== "string") return "";
	return v.trim();
}

function shortBody(data) {
	if (data == null) return null;
	if (typeof data === "string") {
		return data.length > 3000 ? data.slice(0, 3000) + "...<truncated>" : data;
	}
	try {
		const text = JSON.stringify(data, null, 2);
		return text.length > 3000 ? text.slice(0, 3000) + "...<truncated>" : data;
	} catch {
		return String(data);
	}
}

export class SoundCloudClient {
	constructor({ accessToken, clientId, onUnauthorized = null, logger = null }) {
		this.clientId = clientId;
		this.accessToken = accessToken;
		this.onUnauthorized = onUnauthorized;
		this.refreshInFlight = null;
		this.logger = logger;
		
		this.http = axios.create({
			baseURL: "https://api.soundcloud.com",
			timeout: 30000,
			headers: this.getAuthHeaders()
		});
	}
	
	setAccessToken(accessToken) {
		this.accessToken = accessToken;
		this.http.defaults.headers.Authorization = `OAuth ${accessToken}`;
	}
	
	resolveResourceRef(resourceOrValue) {
		if (resourceOrValue == null) {
			return { id: null, urn: null, key: null, raw: null };
		}
		
		if (typeof resourceOrValue === "number") {
			const id = Number.isFinite(resourceOrValue) ? String(resourceOrValue) : null;
			return { id, urn: null, key: id, raw: id };
		}
		
		if (typeof resourceOrValue === "string") {
			const value = resourceOrValue.trim();
			if (!value) return { id: null, urn: null, key: null, raw: null };
			
			if (/^soundcloud:/i.test(value)) {
				const numericTail = value.match(/:(\d+)$/);
				return {
					id: numericTail ? numericTail[1] : null,
					urn: value,
					key: value,
					raw: value
				};
			}
			
			if (/^\d+$/.test(value)) {
				return { id: value, urn: null, key: value, raw: value };
			}
			
			return { id: null, urn: null, key: value, raw: value };
		}
		
		if (typeof resourceOrValue === "object") {
			const key = asTrimmedString(resourceOrValue.key) || null;
			const urn = asTrimmedString(resourceOrValue.urn) || null;
			const idRaw =
				typeof resourceOrValue.id === "number"
					? String(resourceOrValue.id)
					: asTrimmedString(resourceOrValue.id) || null;
			
			const id =
				idRaw && /^\d+$/.test(idRaw)
					? idRaw
					: urn && /:(\d+)$/.test(urn)
						? urn.match(/:(\d+)$/)[1]
						: null;
			
			return {
				id,
				urn,
				key: key || urn || id,
				raw: key || urn || id
			};
		}
		
		return { id: null, urn: null, key: null, raw: null };
	}
	
	resolveResourceKey(resourceOrValue) {
		return this.resolveResourceRef(resourceOrValue).key;
	}
	
	resolveNumericId(resourceOrValue) {
		return this.resolveResourceRef(resourceOrValue).id;
	}
	
	getAuthHeaders(extra = {}) {
		return {
			accept: "application/json; charset=utf-8",
			Authorization: `OAuth ${this.accessToken}`,
			...extra
		};
	}
	
	async refreshAuthIfNeeded() {
		if (typeof this.onUnauthorized !== "function") return false;
		
		if (!this.refreshInFlight) {
			this.refreshInFlight = (async () => {
				const refreshed = await this.onUnauthorized();
				if (refreshed?.access_token) {
					this.setAccessToken(refreshed.access_token);
					return true;
				}
				return false;
			})().finally(() => {
				this.refreshInFlight = null;
			});
		}
		
		return await this.refreshInFlight;
	}
	
	logRequestStart(finalConfig) {
		this.logger?.request("HTTP request", {
			method: finalConfig.method || "GET",
			baseURL: finalConfig.baseURL || this.http.defaults.baseURL,
			url: finalConfig.url,
			params: finalConfig.params || null,
			headers: finalConfig.headers || null,
			data: shortBody(finalConfig.data)
		});
	}
	
	logRequestSuccess(finalConfig, res) {
		this.logger?.request("HTTP response", {
			method: finalConfig.method || "GET",
			url: finalConfig.url,
			status: res?.status,
			statusText: res?.statusText,
			data: shortBody(res?.data)
		});
	}
	
	logRequestError(finalConfig, e) {
		this.logger?.request("HTTP error", {
			method: finalConfig.method || "GET",
			url: finalConfig.url,
			status: e?.response?.status || null,
			statusText: e?.response?.statusText || null,
			requestHeaders: finalConfig.headers || null,
			params: finalConfig.params || null,
			data: shortBody(finalConfig.data),
			responseData: shortBody(e?.response?.data || e?.message || null)
		});
	}
	
	async request(config, { retryOn401 = true } = {}) {
		const finalConfig = {
			...config,
			headers: {
				...this.getAuthHeaders(),
				...(config.headers || {})
			}
		};
		
		this.logRequestStart(finalConfig);
		
		try {
			const res = await this.http.request(finalConfig);
			this.logRequestSuccess(finalConfig, res);
			return res.data;
		} catch (e) {
			this.logRequestError(finalConfig, e);
			
			const status = e?.response?.status;
			
			if (status === 401 && retryOn401) {
				const refreshed = await this.refreshAuthIfNeeded();
				if (refreshed) {
					return await this.request(config, { retryOn401: false });
				}
				throw new Error("Не авторизован (токен недействителен/просрочен).");
			}
			
			throw e;
		}
	}
	
	async me() {
		return await this.request({ method: "GET", url: "/me" });
	}
	
	async searchTracks({ q, limit = 30 }) {
		const data = await this.request({
			method: "GET",
			url: "/tracks",
			params: { q, limit, linked_partitioning: 1 }
		});
		return normalizeCollection(data);
	}
	
	async likeTrack(trackId) {
		const key = this.resolveResourceKey(trackId);
		if (!key) throw new Error("Не указан идентификатор трека.");
		return await this.request({
			method: "POST",
			url: `/likes/tracks/${encodeURIComponent(key)}`
		});
	}
	
	async isTrackLikedBestEffort(trackId) {
		const key = this.resolveResourceKey(trackId);
		if (!key) return null;
		
		try {
			await this.request({
				method: "GET",
				url: `/me/likes/tracks/${encodeURIComponent(key)}`
			});
			return true;
		} catch (e) {
			const status = e?.response?.status;
			if (status === 404) return false;
			if (status === 401) throw new Error("Не авторизован (токен недействителен/просрочен).");
			return null;
		}
	}
	
	async getMyPlaylists({ limit = 200 } = {}) {
		const data = await this.request({
			method: "GET",
			url: "/me/playlists",
			params: {
				show_tracks: false,
				linked_partitioning: true,
				limit
			}
		});
		return normalizeCollection(data);
	}
	
	async findMyPlaylistByUrl(url) {
		const targetUrl = normalizeUrl(url);
		const targetPath = safeUrlPath(url);
		
		if (!targetUrl && !targetPath) return null;
		
		const playlists = await this.getMyPlaylists({ limit: 200 });
		
		for (const playlist of playlists) {
			const permalinkUrl = normalizeUrl(playlist?.permalink_url);
			const permalinkUrlPath = safeUrlPath(playlist?.permalink_url);
			const playlistPermalink = String(playlist?.permalink || "").trim().toLowerCase();
			const userPermalink = String(playlist?.user?.permalink || "").trim().toLowerCase();
			
			const constructedPath =
				userPermalink && playlistPermalink
					? `/${userPermalink}/sets/${playlistPermalink}`.toLowerCase()
					: "";
			
			if (
				(permalinkUrl && permalinkUrl === targetUrl) ||
				(permalinkUrlPath && permalinkUrlPath === targetPath) ||
				(constructedPath && constructedPath === targetPath)
			) {
				return playlist;
			}
		}
		
		return null;
	}
	
	async getPlaylist(playlistRef) {
		const key = this.resolveResourceKey(playlistRef);
		if (!key) throw new Error("Не указан идентификатор плейлиста.");
		
		return await this.request({
			method: "GET",
			url: `/playlists/${encodeURIComponent(key)}`,
			params: {
				show_tracks: true
			}
		});
	}
	
	normalizeTrackRefs(tracks) {
		return tracks
		.map((t) => {
			const ref = this.resolveResourceRef(t?.id != null || t?.urn != null || t?.key != null ? t : (t?.track || t));
			const id = ref.id ? Number(ref.id) : null;
			if (!ref.id && !ref.urn) return null;
			
			return {
				id: Number.isFinite(id) ? id : null,
				urn: ref.urn || null
			};
		})
		.filter(Boolean);
	}
	
	buildPlaylistTracksForm(tracks) {
		const form = new URLSearchParams();
		
		for (let i = 0; i < tracks.length; i++) {
			if (tracks[i].urn) {
				form.append("playlist[tracks][][urn]", String(tracks[i].urn));
			}
			if (Number.isFinite(tracks[i].id)) {
				form.append("playlist[tracks][][id]", String(tracks[i].id));
			}
		}
		
		return form;
	}
	
	async updatePlaylistTracks(playlistRef, tracks, options = {}) {
		const playlistKey = this.resolveResourceKey(playlistRef);
		if (!playlistKey) {
			throw new Error("Не указан идентификатор плейлиста.");
		}
		
		const normalizedTracks = this.normalizeTrackRefs(tracks);
		if (!normalizedTracks.length) {
			throw new Error("После нормализации не осталось валидных track id/urn для обновления плейлиста.");
		}
		
		const form = this.buildPlaylistTracksForm(normalizedTracks);
		const params = {};
		
		if (options.secretToken) {
			params.secret_token = options.secretToken;
		}
		
		return await this.request(
			{
				method: "PUT",
				url: `/playlists/${encodeURIComponent(playlistKey)}`,
				params,
				data: form.toString(),
				headers: {
					"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
				}
			},
			{ retryOn401: true }
		);
	}
}