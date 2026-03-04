import axios from "axios";

function normalizeCollection(data) {
	if (Array.isArray(data)) return data;
	if (data && Array.isArray(data.collection)) return data.collection;
	return [];
}

export class SoundCloudClient {
	constructor({ accessToken }) {
		this.http = axios.create({
			baseURL: "https://api.soundcloud.com",
			timeout: 30000,
			headers: {
				accept: "application/json; charset=utf-8",
				Authorization: `OAuth ${accessToken}`
			}
		});
	}
	
	async me() {
		const { data } = await this.http.get("/me");
		return data;
	}
	
	async searchTracks({ q, limit = 30 }) {
		const { data } = await this.http.get("/tracks", {
			params: { q, limit, linked_partitioning: 1 }
		});
		return normalizeCollection(data);
	}
	
	async likeTrack(trackId) {
		const { data } = await this.http.post(`/likes/tracks/${encodeURIComponent(trackId)}`);
		return data;
	}
	
	// “проверка лайка” до лайка:
	// У SoundCloud это не всегда стабильно доступно. Мы делаем best-effort:
	// - 200 -> liked
	// - 404 -> not liked
	// - остальное -> null (не знаем)
	async isTrackLikedBestEffort(trackId) {
		try {
			await this.http.get(`/me/likes/tracks/${encodeURIComponent(trackId)}`);
			return true;
		} catch (e) {
			const status = e?.response?.status;
			if (status === 404) return false;
			if (status === 401) throw new Error("Не авторизован (токен недействителен/просрочен).");
			return null;
		}
	}
}