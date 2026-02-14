const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const loadMoreBtn = document.getElementById('load-more');
const statsEl = document.getElementById('stats');

let currentQuery = '';
let currentOffset = 0;
const PAGE_SIZE = 20;

// Load stats on page load
fetch('/api/stats')
    .then(r => r.json())
    .then(data => {
        statsEl.textContent = `${data.documents.toLocaleString()} chunks indexed`;
    })
    .catch(() => {});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
});
searchBtn.addEventListener('click', doSearch);
loadMoreBtn.addEventListener('click', loadMore);

async function doSearch() {
    const q = searchInput.value.trim();
    if (!q) return;

    currentQuery = q;
    currentOffset = 0;
    resultsEl.innerHTML = '';
    loadMoreBtn.style.display = 'none';
    statusEl.textContent = 'Searching...';

    await fetchResults();
}

async function loadMore() {
    await fetchResults();
}

async function fetchResults() {
    try {
        const params = new URLSearchParams({
            q: currentQuery,
            limit: PAGE_SIZE,
            offset: currentOffset
        });

        const resp = await fetch(`/api/search?${params}`);
        if (!resp.ok) {
            const text = await resp.text();
            statusEl.textContent = `Error: ${text}`;
            return;
        }

        const data = await resp.json();

        statusEl.textContent = `${data.totalHits} results (${data.processingTimeMs}ms)`;

        for (const hit of data.hits) {
            resultsEl.appendChild(createResultCard(hit));
        }

        currentOffset += data.hits.length;

        loadMoreBtn.style.display =
            currentOffset < data.totalHits ? 'block' : 'none';
    } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
    }
}

function createResultCard(hit) {
    const card = document.createElement('div');
    card.className = 'result-card';

    const name = hit.session.name || hit.session.path.split('/').pop() || hit.session.id.slice(0, 8);
    const flavor = hit.session.flavor || '';
    const time = formatTime(hit.createdAt);

    card.innerHTML = `
        <div class="result-header">
            <span class="session-name">${esc(name)}</span>
            ${flavor ? `<span class="session-flavor">${esc(flavor)}</span>` : ''}
        </div>
        ${hit.session.path ? `<div class="session-path">${esc(hit.session.path)}</div>` : ''}
        <div class="result-role">${esc(hit.role)}</div>
        <div class="result-text">${hit.text}</div>
        <div class="result-footer">
            <span class="result-time">${time}</span>
            <a class="result-link" href="${esc(hit.session.url)}" target="_blank">Open session &rarr;</a>
        </div>
    `;

    return card;
}

function formatTime(ts) {
    if (!ts) return '';
    const date = new Date(ts);
    const now = new Date();
    const diff = now - date;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 30) return `${days}d ago`;
    return date.toLocaleDateString();
}

function esc(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}
