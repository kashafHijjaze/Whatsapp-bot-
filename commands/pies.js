const fetch = require('node-fetch');

const BASE = 'https://api.shizo.top/pies';
const VALID_COUNTRIES = ['india', 'malaysia', 'thailand', 'china', 'indonesia', 'japan', 'korea', 'vietnam'];

const FALLBACK_URLS = {
	india: [
		'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop&q=80',
		'https://images.unsplash.com/photo-1617627143750-d86bc21e42bb?w=800&auto=format&fit=crop&q=80'
	],
	malaysia: [
		'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=800&auto=format&fit=crop&q=80',
		'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=800&auto=format&fit=crop&q=80'
	],
	thailand: [
		'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=800&auto=format&fit=crop&q=80',
		'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&auto=format&fit=crop&q=80'
	],
	china: [
		'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=800&auto=format&fit=crop&q=80',
		'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=800&auto=format&fit=crop&q=80'
	],
	indonesia: [
		'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=800&auto=format&fit=crop&q=80',
		'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=800&auto=format&fit=crop&q=80'
	],
	japan: [
		'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=800&auto=format&fit=crop&q=80',
		'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=800&auto=format&fit=crop&q=80'
	],
	korea: [
		'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop&q=80',
		'https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?w=800&auto=format&fit=crop&q=80'
	],
	vietnam: [
		'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=800&auto=format&fit=crop&q=80',
		'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=800&auto=format&fit=crop&q=80'
	]
};

async function fetchPiesImageBuffer(country) {
	// 1. Try primary API
	try {
		const url = `${BASE}/${country}?apikey=shizo`;
		const res = await fetch(url, { timeout: 8000 });
		if (res.ok) {
			const contentType = res.headers.get('content-type') || '';
			if (contentType.includes('image')) {
				return await res.buffer();
			} else if (contentType.includes('application/json')) {
				const json = await res.json().catch(() => null);
				const imgUrl = json?.result || json?.url || json?.image || json?.link;
				if (imgUrl && typeof imgUrl === 'string') {
					const imgRes = await fetch(imgUrl, { timeout: 8000 });
					if (imgRes.ok) return await imgRes.buffer();
				}
			}
		}
	} catch (e) {
		// Ignore primary failure, fallback will handle
	}

	// 2. Try fallback random image provider
	try {
		const flickrUrl = `https://loremflickr.com/720/1080/${encodeURIComponent(country)},portrait/all`;
		const res = await fetch(flickrUrl, { timeout: 8000, redirect: 'follow' });
		if (res.ok) {
			const contentType = res.headers.get('content-type') || '';
			if (contentType.includes('image')) {
				return await res.buffer();
			}
		}
	} catch (e) {
		// Ignore provider failure, curated fallback will handle
	}

	// 3. Try curated high-res fallback list
	const list = FALLBACK_URLS[country] || FALLBACK_URLS.indonesia;
	const selected = list[Math.floor(Math.random() * list.length)];
	try {
		const res = await fetch(selected, { timeout: 8000 });
		if (res.ok) {
			return await res.buffer();
		}
	} catch (e) {
		// Last attempt fallback
	}

	throw new Error(`Unable to fetch portrait image for ${country}`);
}

async function piesCommand(sock, chatId, message, args) {
	const sub = (args && args[0] ? args[0] : '').toLowerCase();
	if (!sub) {
		await sock.sendMessage(chatId, { text: `Usage: .pies <country>\nCountries: ${VALID_COUNTRIES.join(', ')}` }, { quoted: message });
		return;
	}
	if (!VALID_COUNTRIES.includes(sub)) {
		await sock.sendMessage(chatId, { text: `❌ Unsupported country: ${sub}. Try one of: ${VALID_COUNTRIES.join(', ')}` }, { quoted: message });
		return;
	}
	try {
		const imageBuffer = await fetchPiesImageBuffer(sub);
		await sock.sendMessage(
			chatId,
			{ image: imageBuffer, caption: `pies: ${sub}` },
			{ quoted: message }
		);
	} catch (err) {
		console.warn(`[pies] Warning fetching image for ${sub}:`, err.message || err);
		await sock.sendMessage(chatId, { text: '❌ Failed to fetch image. Please try again.' }, { quoted: message });
	}
}

async function piesAlias(sock, chatId, message, country) {
	try {
		const imageBuffer = await fetchPiesImageBuffer(country);
		await sock.sendMessage(
			chatId,
			{ image: imageBuffer, caption: `pies: ${country}` },
			{ quoted: message }
		);
	} catch (err) {
		console.warn(`[pies] Warning fetching alias image for ${country}:`, err.message || err);
		await sock.sendMessage(chatId, { text: '❌ Failed to fetch image. Please try again.' }, { quoted: message });
	}
}

module.exports = { piesCommand, piesAlias, VALID_COUNTRIES, fetchPiesImageBuffer };
