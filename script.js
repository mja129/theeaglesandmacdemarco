const CLIENT_ID = "5ae954a9c9e54a41bf4a4f8566c1a65b";

const DEV = true;

const REDIRECT_URI = DEV
  ? "http://127.0.0.1:5500/callback.html"
  : "https://mja129.github.io/theeaglesandmacdemarco/callback.html";
const SCOPES = [
  "playlist-modify-public",
  "playlist-modify-private",
  "user-read-private",
].join(" ");

// --- PKCE ---

function base64URLEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function generateCodeVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}

async function generateCodeChallenge(verifier) {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64URLEncode(digest);
}

// --- Auth ---

async function startLogin() {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  localStorage.setItem("code_verifier", verifier);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

function getToken() {
  const token = localStorage.getItem("spotify_token");
  const expiry = localStorage.getItem("spotify_token_expiry");
  if (!token || !expiry) return null;
  if (Date.now() > parseInt(expiry)) {
    localStorage.removeItem("spotify_token");
    localStorage.removeItem("spotify_token_expiry");
    return null;
  }
  return token;
}

function logout() {
  localStorage.removeItem("spotify_token");
  localStorage.removeItem("spotify_token_expiry");
  renderAuthState();
}

// --- Spotify API ---

async function spotifyFetch(path, options = {}) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Spotify API error ${res.status}: ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

// --- State ---

let artists = [];
let searchTimeout = null;

// --- Search ---

async function searchArtists(query) {
  const data = await spotifyFetch(
    `/search?q=${encodeURIComponent(query)}&type=artist&limit=6`
  );
  return data.artists.items;
}

function showResults(results) {
  const dropdown = document.getElementById("search-results");
  dropdown.innerHTML = "";

  if (!results.length) {
    dropdown.style.display = "none";
    return;
  }

  results.forEach((artist) => {
    const item = document.createElement("div");
    item.className = "result-item";
    const imgUrl = artist.images[0]?.url;
    item.innerHTML = `
      ${imgUrl ? `<img src="${imgUrl}" alt="">` : `<div class="avatar-placeholder"></div>`}
      <span>${artist.name}</span>
    `;
    item.addEventListener("click", () => {
      addArtist(artist);
    });
    dropdown.appendChild(item);
  });

  dropdown.style.display = "block";
}

function addArtist(artist) {
  if (artists.some((a) => a.id === artist.id)) return;
  artists.push({
    id: artist.id,
    name: artist.name,
    image: artist.images[0]?.url,
  });
  document.getElementById("search-input").value = "";
  document.getElementById("search-results").style.display = "none";
  renderArtistList();
}

function removeArtist(id) {
  artists = artists.filter((a) => a.id !== id);
  renderArtistList();
}

function renderArtistList() {
  const list = document.getElementById("artist-list");
  list.innerHTML = "";

  artists.forEach((a) => {
    const item = document.createElement("div");
    item.className = "artist-item";
    item.innerHTML = `
      ${a.image ? `<img src="${a.image}" alt="">` : `<div class="avatar-placeholder"></div>`}
      <span>${a.name}</span>
      <button class="remove-btn" title="Remove">&#x2715;</button>
    `;
    item.querySelector(".remove-btn").addEventListener("click", () => removeArtist(a.id));
    list.appendChild(item);
  });
}

// --- Playlist creation ---

async function fetchTracksForArtist(artist, count) {
  const uris = [];
  const PAGE = 10;
  const MAX_CHECKED = count * 20;
  let offset = 0;

  while (uris.length < count && offset < MAX_CHECKED) {
    const data = await spotifyFetch(
      `/search?q=${encodeURIComponent(artist.name)}&type=track&limit=${PAGE}&offset=${offset}`
    );
    const page = data.tracks.items;
    if (!page.length) break;

    for (const t of page) {
      if (t.artists.some((ar) => ar.id === artist.id)) {
        uris.push(t.uri);
        if (uris.length === count) break;
      }
    }

    if (page.length < PAGE) break;
    offset += PAGE;
  }

  return uris;
}

async function createPlaylist() {
  const songsPerArtist = Math.max(1, parseInt(document.getElementById("songs-per-artist").value) || 3);
  const playlistName =
    document.getElementById("playlist-name").value.trim() || "My Mixed Playlist";

  if (artists.length === 0) {
    setStatus("Add at least one artist first.");
    return;
  }

  try {
    setStatus("Fetching user profile...");
    const profile = await spotifyFetch("/me");

    setStatus("Fetching tracks for each artist...");
    const artistTracks = await Promise.all(
      artists.map((a) => fetchTracksForArtist(a, songsPerArtist))
    );

    console.log(artistTracks);
    // Round-robin interleave: slot 0 from each artist, then slot 1, etc.
    const trackUris = [];
    for (let i = 0; i < songsPerArtist; i++) {
      for (let j = 0; j < artistTracks.length; j++) {
          if (artistTracks[j][i]) { trackUris.push(artistTracks[j][i]); }
      }
    }

    setStatus("Creating playlist...");
    const playlist = await spotifyFetch(`/me/playlists`, {
      method: "POST",
      body: JSON.stringify({
        name: playlistName,
        public: false,
        description: "Created by TheEaglesAndMacDemarco",
      }),
    });

    // Spotify's add-tracks endpoint accepts max 100 URIs at a time
    for (let i = 0; i < trackUris.length; i += 100) {
      await spotifyFetch(`/playlists/${playlist.id}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: trackUris.slice(i, i + 100) }),
      });
    }

    setStatus(
      `Done! <a href="${playlist.external_urls.spotify}" target="_blank">Open "${playlistName}" in Spotify</a>`
    );
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

function setStatus(msg) {
  document.getElementById("status").innerHTML = msg;
}

// --- UI ---

function renderAuthState() {
  const loggedIn = !!getToken();
  document.getElementById("login-section").style.display = loggedIn ? "none" : "flex";
  document.getElementById("app-section").style.display = loggedIn ? "block" : "none";
}

function init() {
  renderAuthState();

  document.getElementById("login-btn").addEventListener("click", startLogin);
  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("create-btn").addEventListener("click", createPlaylist);

  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (!q) {
      document.getElementById("search-results").style.display = "none";
      return;
    }
    searchTimeout = setTimeout(async () => {
      try {
        const results = await searchArtists(q);
        showResults(results);
      } catch (err) {
        console.error("Search error:", err);
      }
    }, 300);
  });

  // Close dropdown when clicking outside the search area
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#search-wrapper")) {
      document.getElementById("search-results").style.display = "none";
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
