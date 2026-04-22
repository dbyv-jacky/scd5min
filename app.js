const BOARD_DATA_URL = "board.data.json";
const EMBED_MESSAGE_TYPE = "social-wall:resize";
const EMBED_SYNC_DELAY_MS = 120;

const appRoot = document.getElementById("app");
const filterRoot = document.getElementById("filters");

const state = {
  data: null,
  activeFilter: "all"
};

boot().catch((error) => {
  console.error("Board runtime bootstrap failed", error);
});

async function boot() {
  const bootstrapData = readBootstrapData();

  if (bootstrapData) {
    state.data = bootstrapData;
    render();
  }

  const freshData = await fetchBoardData();

  if (freshData) {
    state.data = freshData;
    render();
  }

  bindGlobalListeners();
}

function readBootstrapData() {
  const node = document.getElementById("board-bootstrap");

  if (!node?.textContent) {
    return null;
  }

  try {
    return JSON.parse(node.textContent);
  } catch {
    return null;
  }
}

async function fetchBoardData() {
  if (window.location.protocol === "file:") {
    return null;
  }

  try {
    const response = await fetch(`${BOARD_DATA_URL}?t=${Date.now()}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

function bindGlobalListeners() {
  if (filterRoot) {
    filterRoot.addEventListener("click", handleFilterClick);
  }

  window.addEventListener("resize", scheduleEmbedHeightSync);
  window.addEventListener("load", scheduleEmbedHeightSync);

  if (document.fonts?.ready) {
    document.fonts.ready.then(scheduleEmbedHeightSync).catch(() => {});
  }

  if (typeof ResizeObserver === "function" && appRoot) {
    const observer = new ResizeObserver(() => {
      scheduleEmbedHeightSync();
    });
    observer.observe(appRoot);
  }
}

function handleFilterClick(event) {
  const button = event.target.closest("[data-filter]");

  if (!button || !button.dataset.filter) {
    return;
  }

  state.activeFilter = button.dataset.filter;
  renderFilters();
  renderFeed();
}

function render() {
  renderShell();
  renderFilters();
  renderFeed();
}

function renderShell() {
  if (!appRoot || !state.data) {
    return;
  }

  const { config } = state.data;

  document.title = `${config.name || state.data.board.name}`;
  document.documentElement.dataset.theme = config.style.theme;
  document.documentElement.style.setProperty("--board-accent", config.style.accentColor);
  document.documentElement.style.setProperty("--board-gap", `${config.layout.itemSpacing}px`);
  document.documentElement.style.setProperty("--board-columns", String(config.layout.columns));
  document.documentElement.style.setProperty("--board-font", config.style.fontFamily);

  appRoot.innerHTML = `
    <main class="board-shell">
      <header class="board-header">
        <p class="eyebrow">${escapeHtml(state.data.board.id)}</p>
        <h1>${escapeHtml(config.header.title)}</h1>
        <p class="board-caption">${escapeHtml(config.header.caption || "")}</p>
      </header>
      <nav class="filters${config.header.showTabs ? "" : " is-hidden"}" id="filters"></nav>
      <section class="board-grid board-grid--${escapeHtml(config.layout.mode)}" id="board-grid"></section>
    </main>
  `;

  const nextFilterRoot = document.getElementById("filters");

  if (nextFilterRoot && nextFilterRoot !== filterRoot) {
    nextFilterRoot.addEventListener("click", handleFilterClick);
  }
}

function renderFilters() {
  const filtersNode = document.getElementById("filters");

  if (!filtersNode || !state.data) {
    return;
  }

  const platforms = Array.isArray(state.data.platforms) ? state.data.platforms : [];
  filtersNode.innerHTML = [
    createFilterButton("all", "All Sources"),
    ...platforms.map((platform) => createFilterButton(platform, titleCase(platform)))
  ].join("");
}

function createFilterButton(value, label) {
  const isActive = state.activeFilter === value;

  return `
    <button
      type="button"
      class="filter-btn${isActive ? " is-active" : ""}"
      data-filter="${escapeHtml(value)}"
      aria-pressed="${String(isActive)}"
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function renderFeed() {
  const feedNode = document.getElementById("board-grid");

  if (!feedNode || !state.data) {
    return;
  }

  const cards = getVisibleCards();

  if (!cards.length) {
    feedNode.innerHTML = `
      <article class="empty-card">
        <p class="eyebrow">No posts</p>
        <h2>No cards match this view</h2>
        <p>Run the collector again or switch filters.</p>
      </article>
    `;
    scheduleEmbedHeightSync();
    return;
  }

  feedNode.innerHTML = cards.map(renderCard).join("");

  feedNode.querySelectorAll("img[data-remote-src], video[poster][data-remote-poster]").forEach((mediaNode) => {
    if (mediaNode.tagName === "IMG") {
      mediaNode.addEventListener("error", handleImageFallback, { once: true });
      mediaNode.addEventListener("load", scheduleEmbedHeightSync, { once: true });
      return;
    }

    mediaNode.addEventListener("loadedmetadata", scheduleEmbedHeightSync, { once: true });
    mediaNode.addEventListener("error", () => {
      const remotePoster = mediaNode.dataset.remotePoster;

      if (remotePoster) {
        mediaNode.poster = remotePoster;
        delete mediaNode.dataset.remotePoster;
      } else {
        mediaNode.poster = createFallbackArtworkDataUri(mediaNode.dataset.fallbackLabel || "Post");
      }
      scheduleEmbedHeightSync();
    }, { once: true });
  });

  scheduleEmbedHeightSync();
}

function renderCard(card) {
  const mediaMarkup = createMediaMarkup(card);
  const sourceLine = card.display.showSource ? `<p class="card-source">${escapeHtml(formatSourceLabel(card))}</p>` : "";
  const copyMarkup = card.display.showText
    ? `
        <div class="card-copy">
          <h2>${escapeHtml(card.title)}</h2>
          <p style="--line-clamp:${card.display.textPreviewLines}">${escapeHtml(card.excerpt)}</p>
        </div>
      `
    : "";
  const metrics = card.display.showActionsBar
    ? `
      <footer class="card-metrics">
        ${card.display.showLikes ? `<span>Likes ${card.metrics.likes}</span>` : ""}
        ${card.display.showComments ? `<span>Comments ${card.metrics.comments}</span>` : ""}
        ${card.display.showShares ? `<span>Shares ${card.metrics.shares}</span>` : ""}
      </footer>
    `
    : "";
  const authorAvatar = card.display.showAuthorPicture
    ? createAvatarMarkup(card)
    : "";
  const externalLinkAttrs = card.permalink ? `href="${escapeHtml(card.permalink)}" target="_blank" rel="noreferrer"` : "";

  return `
    <article class="card">
      ${mediaMarkup}
      <div class="card-body">
        <div class="card-meta">
          ${authorAvatar}
          <div>
            ${card.display.showAuthorName ? `<strong>${escapeHtml(card.authorName)}</strong>` : ""}
            ${card.display.showDate ? `<p>${escapeHtml(card.dateLabel)}</p>` : ""}
          </div>
        </div>
        ${copyMarkup}
        ${sourceLine}
        ${metrics}
        ${card.permalink ? `<a class="card-link" ${externalLinkAttrs}>Open original post</a>` : ""}
      </div>
    </article>
  `;
}

function createMediaMarkup(card) {
  if (!card.media) {
    return "";
  }

  const label = card.title || card.authorName || card.platform;
  const fallbackSrc = createFallbackArtworkDataUri(label);

  if (card.media.kind === "video" && card.media.url) {
    const autoplay = card.display.videoAutoplay ? "autoplay muted loop playsinline" : "controls playsinline";
    const poster = escapeHtml(card.media.thumbnailUrl || card.media.remoteUrl || fallbackSrc);

    return `
      <div class="card-media"${createMediaStyle(card.media)}>
        <video ${autoplay} preload="metadata" poster="${poster}" data-remote-poster="${escapeHtml(card.media.remoteUrl || "")}" data-fallback-label="${escapeHtml(label)}">
          <source src="${escapeHtml(card.media.url)}" />
        </video>
        <span class="media-pill">${escapeHtml(card.postType)}</span>
      </div>
    `;
  }

  const primarySrc = escapeHtml(card.media.thumbnailUrl || card.media.url || fallbackSrc);
  const remoteSrc = escapeHtml(card.media.remoteUrl || "");

  return `
    <div class="card-media"${createMediaStyle(card.media)}>
      <img
        src="${primarySrc}"
        alt="${escapeHtml(label)}"
        data-remote-src="${remoteSrc}"
        data-fallback-src="${escapeHtml(fallbackSrc)}"
      />
      <span class="media-pill">${escapeHtml(card.postType)}</span>
    </div>
  `;
}

function createAvatarMarkup(card) {
  const initial = escapeHtml((card.authorName || card.platform || "?").charAt(0).toUpperCase());
  const primarySrc = card.authorAvatarUrl ? escapeHtml(card.authorAvatarUrl) : "";
  const remoteSrc = card.authorAvatarRemoteUrl ? escapeHtml(card.authorAvatarRemoteUrl) : "";

  if (!primarySrc && !remoteSrc) {
    return `<span class="avatar-badge">${initial}</span>`;
  }

  return `
    <img
      class="avatar-image"
      src="${primarySrc || remoteSrc}"
      alt="${escapeHtml(card.authorName)} profile"
      data-remote-src="${remoteSrc}"
      data-fallback-src=""
    />
  `;
}

function handleImageFallback(event) {
  const image = event.currentTarget;
  const remoteSrc = image.dataset.remoteSrc;
  const fallbackSrc = image.dataset.fallbackSrc;

  if (remoteSrc && image.src !== remoteSrc) {
    image.src = remoteSrc;
    delete image.dataset.remoteSrc;
    return;
  }

  if (fallbackSrc && image.src !== fallbackSrc) {
    image.src = fallbackSrc;
  }
}

function getVisibleCards() {
  const cards = Array.isArray(state.data?.cards) ? state.data.cards : [];

  if (state.activeFilter === "all") {
    return cards;
  }

  return cards.filter((card) => card.platform === state.activeFilter);
}

function formatSourceLabel(card) {
  const badge = card.platform === "instagram" ? "IG" : card.platform === "facebook" ? "FB" : card.platform.toUpperCase();

  if (card.display.sourceStyle === "icon") {
    return badge;
  }

  if (card.display.sourceStyle === "text") {
    return card.sourceName;
  }

  return `${badge} · ${card.sourceName}`;
}

function createMediaStyle(media) {
  if (!media?.width || !media?.height) {
    return "";
  }

  const ratio = Math.max(0.56, Math.min(1.78, media.width / media.height));
  return ` style="aspect-ratio:${ratio};"`;
}

function scheduleEmbedHeightSync() {
  window.clearTimeout(scheduleEmbedHeightSync.timerId);
  scheduleEmbedHeightSync.timerId = window.setTimeout(() => {
    if (!appRoot || window.parent === window) {
      return;
    }

    window.parent.postMessage(
      {
        type: EMBED_MESSAGE_TYPE,
        height: Math.ceil(appRoot.getBoundingClientRect().height)
      },
      "*"
    );
  }, EMBED_SYNC_DELAY_MS);
}

function createFallbackArtworkDataUri(label) {
  const normalizedLabel = escapeHtml((label || "Post").slice(0, 42));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 900">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#1c1714"/>
          <stop offset="100%" stop-color="#da5d36"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="900" fill="url(#g)"/>
      <circle cx="1020" cy="180" r="180" fill="rgba(255,255,255,0.12)"/>
      <circle cx="180" cy="720" r="240" fill="rgba(255,255,255,0.08)"/>
      <text x="80" y="420" fill="#ffffff" font-size="54" font-family="Arial, sans-serif" font-weight="700">${normalizedLabel}</text>
      <text x="80" y="500" fill="rgba(255,255,255,0.82)" font-size="28" font-family="Arial, sans-serif">Media fallback</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function titleCase(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
