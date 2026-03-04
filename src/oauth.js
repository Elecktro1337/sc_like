import crypto from "node:crypto";
import axios from "axios";

function b64url(buf) {
	return buf
	.toString("base64")
	.replace(/\+/g, "-")
	.replace(/\//g, "_")
	.replace(/=+$/g, "");
}

export function makePkce() {
	const verifier = b64url(crypto.randomBytes(32));
	const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

export async function exchangeTokenAuthCode({
												clientId,
												clientSecret,
												redirectUri,
												code,
												codeVerifier
											}) {
	const form = new URLSearchParams();
	form.set("grant_type", "authorization_code");
	form.set("client_id", clientId);
	form.set("client_secret", clientSecret);
	form.set("redirect_uri", redirectUri);
	form.set("code_verifier", codeVerifier);
	form.set("code", code);
	
	const { data } = await axios.post("https://secure.soundcloud.com/oauth/token", form, {
		headers: {
			accept: "application/json; charset=utf-8",
			"Content-Type": "application/x-www-form-urlencoded"
		},
		timeout: 30000
	});
	
	return data;
}

export async function refreshToken({ clientId, clientSecret, refreshToken }) {
	const form = new URLSearchParams();
	form.set("grant_type", "refresh_token");
	form.set("client_id", clientId);
	form.set("client_secret", clientSecret);
	form.set("refresh_token", refreshToken);
	
	const { data } = await axios.post("https://secure.soundcloud.com/oauth/token", form, {
		headers: {
			accept: "application/json; charset=utf-8",
			"Content-Type": "application/x-www-form-urlencoded"
		},
		timeout: 30000
	});
	
	return data;
}