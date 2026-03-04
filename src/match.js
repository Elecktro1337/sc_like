function norm(s) {
	return (s || "")
	.toLowerCase()
	.replace(/[’'"]/g, "")
	.replace(/[()[\]{}_*+~`^|\\]/g, " ")
	.replace(/[.,!?;:]/g, " ")
	.replace(/\s+/g, " ")
	.trim();
}

function tokens(s) {
	const t = norm(s).split(" ").filter(Boolean);
	return t.filter((w) => w.length >= 2 && w !== "ft" && w !== "feat");
}

function jaccard(a, b) {
	const A = new Set(a);
	const B = new Set(b);
	if (!A.size || !B.size) return 0;
	let inter = 0;
	for (const x of A) if (B.has(x)) inter++;
	const union = A.size + B.size - inter;
	return union ? inter / union : 0;
}

function scoreCandidate({ artist, title }, track) {
	const wantTitleTok = tokens(title);
	const wantArtistTok = tokens(artist);
	
	const gotTitle = track?.title || "";
	const gotUser = track?.user?.username || "";
	const gotTitleTok = tokens(gotTitle);
	const gotUserTok = tokens(gotUser);
	
	const titleSim = jaccard(wantTitleTok, gotTitleTok);
	const artistSim = jaccard(wantArtistTok, gotUserTok);
	
	const wantTitleNorm = norm(title);
	const gotTitleNorm = norm(gotTitle);
	const substrBonus =
		gotTitleNorm.includes(wantTitleNorm) || wantTitleNorm.includes(gotTitleNorm) ? 0.25 : 0;
	
	return titleSim * 0.75 + artistSim * 0.20 + substrBonus * 0.05;
}

export function pickBestMatch(queryObj, candidates) {
	if (!candidates?.length) return null;
	
	const scored = candidates
	.map((t) => ({ t, s: scoreCandidate(queryObj, t) }))
	.sort((a, b) => b.s - a.s);
	
	if (scored[0].s < 0.25) return null;
	return scored[0].t;
}

export function parseLine(line) {
	const idx = line.indexOf(" - ");
	if (idx === -1) return null;
	const artist = line.slice(0, idx).trim();
	const title = line.slice(idx + 3).trim();
	if (!artist || !title) return null;
	return { artist, title };
}