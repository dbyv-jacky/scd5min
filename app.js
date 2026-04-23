const BOARD_DATA_URL = "board.data.json";
const EMBED_MESSAGE_TYPE = "social-wall:resize";
const EMBED_SYNC_DELAY_MS = 120;

const appRoot = document.getElementById("app");

const state = {
  data: null,
  activeFilter: "all",
  selectedCardId: null,
  visibleCount: 0
};

boot().catch((error) => {
  console.error("Board runtime bootstrap failed", error);
});

async function boot() {
  const bootstrapData = readBootstrapData();

  if (bootstrapData) {
    state.data = bootstrapData;
    resetVisibleCount();
    render();
  }

  const freshData = await fetchBoardData();

  if (freshData) {
    state.data = freshData;
    if (!findCardById(state.selectedCardId)) {
      state.selectedCardId = null;
    }
    resetVisibleCount();
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
  if (appRoot) {
    appRoot.addEventListener("click", handleAppClick);
    appRoot.addEventListener("keydown", handleAppKeydown);
  }

  document.addEventListener("keydown", handleDocumentKeydown);
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

function handleAppClick(event) {
  const closeTrigger = event.target.closest("[data-close-modal]");

  if (closeTrigger) {
    closeModal();
    return;
  }

  const backdrop = event.target.closest("[data-modal-backdrop]");

  if (backdrop && event.target === backdrop) {
    closeModal();
    return;
  }

  const filterButton = event.target.closest("[data-filter]");

  if (filterButton?.dataset.filter) {
    state.activeFilter = filterButton.dataset.filter;
    resetVisibleCount();
    renderFilters();
    renderFeed();
    renderLoadMore();
    return;
  }

  const loadMoreTrigger = event.target.closest("[data-load-more]");

  if (loadMoreTrigger && state.data) {
    state.visibleCount += getPageSize();
    renderFeed();
    renderLoadMore();
    return;
  }

  const cardNode = event.target.closest("[data-card-id]");

  if (!cardNode?.dataset.cardId || event.target.closest("a, button, video")) {
    return;
  }

  openCard(cardNode.dataset.cardId);
}

function handleAppKeydown(event) {
  const cardNode = event.target.closest("[data-card-id]");

  if (!cardNode?.dataset.cardId) {
    return;
  }

  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  openCard(cardNode.dataset.cardId);
}

function handleDocumentKeydown(event) {
  if (event.key === "Escape" && state.selectedCardId) {
    closeModal();
  }
}

function render() {
  renderShell();
  renderFilters();
  renderFeed();
  renderLoadMore();
  renderModal();
}

function renderShell() {
  if (!appRoot || !state.data) {
    return;
  }

  const { config } = state.data;
  const filterMarkup = config.header.showTabs
    ? '<nav class="filters" id="filters" aria-label="Source filters"></nav>'
    : "";

  document.title = `${config.name || state.data.board.name}`;
  document.documentElement.dataset.theme = config.style.theme;
  document.documentElement.style.setProperty("--board-accent", config.style.accentColor);
  document.documentElement.style.setProperty("--board-gap", `${config.layout.itemSpacing}px`);
  document.documentElement.style.setProperty("--board-columns", String(config.layout.columns));
  document.documentElement.style.setProperty("--board-font", config.style.fontFamily);

  appRoot.innerHTML = `
    <main class="board-shell">
      <header class="board-header">
        <h1>${escapeHtml(config.header.title)}</h1>
        <p class="board-caption">${escapeHtml(config.header.caption || "")}</p>
      </header>
      ${filterMarkup}
      <section class="board-grid board-grid--${escapeHtml(config.layout.mode)}" id="board-grid"></section>
      <div class="board-actions" id="board-actions"></div>
    </main>
    <div id="modal-root"></div>
  `;
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

function renderLoadMore() {
  const actionsNode = document.getElementById("board-actions");

  if (!actionsNode || !state.data) {
    return;
  }

  const { config } = state.data;
  const filteredCards = getFilteredCards();

  if (!config.limit.loadMoreEnabled || filteredCards.length <= state.visibleCount) {
    actionsNode.innerHTML = "";
    scheduleEmbedHeightSync();
    return;
  }

  const remainingCards = filteredCards.length - state.visibleCount;

  actionsNode.innerHTML = `
    <button type="button" class="load-more-btn" data-load-more>
      Load More${remainingCards > 0 ? ` (${remainingCards} left)` : ""}
    </button>
  `;

  scheduleEmbedHeightSync();
}

function renderCard(card) {
  const mediaMarkup = createMediaMarkup(card);
  const metaMarkup = createCardMetaMarkup(card);
  const sourceLine = card.display.showSource ? `<p class="card-source">${escapeHtml(formatSourceLabel(card))}</p>` : "";
  const excerptText = card.excerpt || card.text || card.title || "";
  const copyMarkup = card.display.showText
    ? `
        <div class="card-copy">
          <p style="--line-clamp:${card.display.textPreviewLines}">${escapeHtml(excerptText)}</p>
        </div>
      `
    : "";
  const metricsMarkup = createMetricsMarkup(card);
  const isInteractive = canOpenCard(card);
  const interactiveAttrs = isInteractive
    ? ' role="button" tabindex="0" aria-haspopup="dialog"'
    : "";

  return `
    <article class="card${isInteractive ? " is-clickable" : ""}" data-card-id="${escapeHtml(card.id)}"${interactiveAttrs}>
      ${mediaMarkup}
      <div class="card-body">
        ${metaMarkup}
        ${copyMarkup}
        ${sourceLine}
        ${metricsMarkup}
      </div>
    </article>
  `;
}

function renderModal() {
  const modalRoot = document.getElementById("modal-root");
  const selectedCard = getSelectedCard();

  if (!modalRoot || !state.data) {
    return;
  }

  document.body.classList.toggle("has-modal", Boolean(selectedCard));

  if (!selectedCard) {
    modalRoot.innerHTML = "";
    scheduleEmbedHeightSync();
    return;
  }

  const { config } = state.data;
  const modalMediaMarkup = createModalMediaMarkup(selectedCard);
  const metaMarkup = createPopupMetaMarkup(selectedCard);
  const sourceMarkup = selectedCard.display.showSource
    ? `<p class="card-source">${escapeHtml(formatSourceLabel(selectedCard))}</p>`
    : "";
  const originalLinkMarkup = config.interaction.enableExternalLinks && selectedCard.permalink
    ? `<a class="modal-link" href="${escapeHtml(selectedCard.permalink)}" target="_blank" rel="noreferrer">連接到社交平台</a>`
    : "";

  modalRoot.innerHTML = `
    <div class="modal-backdrop modal-backdrop--${escapeHtml(config.interaction.popupAnimation || "dissolve")}" data-modal-backdrop>
      <section
        class="modal-card modal-card--${escapeHtml(config.interaction.popupStyle || "lightbox")} modal-card--${escapeHtml(config.interaction.popupAnimation || "dissolve")}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <button class="modal-close" type="button" data-close-modal>關閉</button>
        <p class="eyebrow">立即播放</p>
        ${modalMediaMarkup}
        ${metaMarkup}
        <h3 id="modal-title">${escapeHtml(selectedCard.title)}</h3>
        <p class="modal-copy">${escapeHtml(selectedCard.excerpt)}</p>
        ${sourceMarkup}
        ${originalLinkMarkup}
      </section>
    </div>
  `;

  scheduleEmbedHeightSync();
}

function createCardMetaMarkup(card) {
  const hasAvatar = card.display.showAuthorPicture;
  const hasAuthorName = card.display.showAuthorName && card.authorName;
  const hasDate = card.display.showDate && card.dateLabel;

  if (!hasAvatar && !hasAuthorName && !hasDate) {
    return "";
  }

  return `
    <div class="card-meta">
      ${hasAvatar ? createAvatarMarkup(card) : ""}
      <div>
        ${hasAuthorName ? `<strong>${escapeHtml(card.authorName)}</strong>` : ""}
        ${hasDate ? `<p>${escapeHtml(card.dateLabel)}</p>` : ""}
      </div>
    </div>
  `;
}

function createPopupMetaMarkup(card) {
  const hasAvatar = card.display.showAuthorPicture;
  const hasAuthorName = card.display.showAuthorName && card.authorName;
  const hasDate = card.display.showDate && card.dateLabel;

  if (!hasAvatar && !hasAuthorName && !hasDate) {
    return "";
  }

  return `
    <div class="modal-card__meta">
      ${hasAvatar ? createAvatarMarkup(card) : ""}
      <div>
        ${hasAuthorName ? `<strong>${escapeHtml(card.authorName)}</strong>` : ""}
        ${hasDate ? `<p>${escapeHtml(card.dateLabel)}</p>` : ""}
      </div>
    </div>
  `;
}

function createMetricsMarkup(card) {
  if (!card.display.showActionsBar) {
    return "";
  }

  return `
    <footer class="card-metrics">
      ${card.display.showLikes ? `<span>Likes ${card.metrics.likes}</span>` : ""}
      ${card.display.showComments ? `<span>Comments ${card.metrics.comments}</span>` : ""}
      ${card.display.showShares ? `<span>Shares ${card.metrics.shares}</span>` : ""}
    </footer>
  `;
}

function createMediaMarkup(card) {
  if (!card.media) {
    return "";
  }

  const label = card.title || card.authorName || card.platform;
  const fallbackSrc = createFallbackArtworkDataUri(label);

  if (card.media.kind === "video" && card.media.url && card.display.videoAutoplay) {
    const poster = escapeHtml(card.media.thumbnailUrl || card.media.remoteUrl || fallbackSrc);

    return `
      <div class="card-media"${createMediaStyle(card.media)}>
        <video autoplay muted loop playsinline preload="metadata" poster="${poster}" data-remote-poster="${escapeHtml(card.media.remoteUrl || "")}" data-fallback-label="${escapeHtml(label)}">
          <source src="${escapeHtml(card.media.url)}" />
        </video>
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
    </div>
  `;
}

function createModalMediaMarkup(card) {
  if (!card.media) {
    return "";
  }

  const label = card.title || card.authorName || card.platform;
  const fallbackSrc = createFallbackArtworkDataUri(label);

  if (card.media.kind === "video" && card.media.url) {
    const poster = escapeHtml(card.media.thumbnailUrl || card.media.remoteUrl || fallbackSrc);
    const playbackAttrs = card.display.videoAutoplay ? "autoplay loop" : "";

    return `
      <div class="modal-card__media"${createMediaStyle(card.media)}>
        <video ${playbackAttrs} controls playsinline preload="metadata" poster="${poster}" data-remote-poster="${escapeHtml(card.media.remoteUrl || "")}" data-fallback-label="${escapeHtml(label)}">
          <source src="${escapeHtml(card.media.url)}" />
        </video>
      </div>
    `;
  }

  const primarySrc = escapeHtml(card.media.thumbnailUrl || card.media.url || fallbackSrc);
  const remoteSrc = escapeHtml(card.media.remoteUrl || "");

  return `
    <div class="modal-card__media"${createMediaStyle(card.media)}>
      <img
        src="${primarySrc}"
        alt="${escapeHtml(label)}"
        data-remote-src="${remoteSrc}"
        data-fallback-src="${escapeHtml(fallbackSrc)}"
      />
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

function getFilteredCards() {
  const cards = Array.isArray(state.data?.cards) ? state.data.cards : [];

  if (state.activeFilter === "all") {
    return cards;
  }

  return cards.filter((card) => card.platform === state.activeFilter);
}

function getVisibleCards() {
  const cards = getFilteredCards();

  if (!state.data?.config?.limit?.loadMoreEnabled) {
    return cards;
  }

  return cards.slice(0, state.visibleCount);
}

function resetVisibleCount() {
  if (!state.data) {
    state.visibleCount = 0;
    return;
  }

  const cards = getFilteredCards();

  if (!state.data.config.limit.loadMoreEnabled) {
    state.visibleCount = cards.length;
    return;
  }

  state.visibleCount = Math.min(getPageSize(), cards.length);
}

function getPageSize() {
  const limit = state.data?.config?.limit;

  if (!limit) {
    return 8;
  }

  if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches) {
    return limit.itemsPerPageMobile || limit.itemsPerPage || 8;
  }

  return limit.itemsPerPage || limit.itemsPerPageMobile || 8;
}

function getSelectedCard() {
  return findCardById(state.selectedCardId);
}

function findCardById(cardId) {
  if (!cardId) {
    return null;
  }

  const cards = Array.isArray(state.data?.cards) ? state.data.cards : [];
  return cards.find((card) => card.id === cardId) || null;
}

function canOpenCard(card) {
  const interactionMode = state.data?.config?.interaction?.onPostClick || "popup";

  if (interactionMode === "disabled") {
    return false;
  }

  if (interactionMode === "new-tab") {
    return Boolean(card.permalink && state.data?.config?.interaction?.enableExternalLinks);
  }

  return true;
}

function openCard(cardId) {
  const card = findCardById(cardId);

  if (!card || !state.data) {
    return;
  }

  const { interaction } = state.data.config;

  if (interaction.onPostClick === "disabled") {
    return;
  }

  if (interaction.onPostClick === "new-tab" && interaction.enableExternalLinks && card.permalink) {
    window.open(card.permalink, interaction.openLinksInNewTab ? "_blank" : "_self", "noopener,noreferrer");
    return;
  }

  state.selectedCardId = card.id;
  renderModal();
}

function closeModal() {
  if (!state.selectedCardId) {
    return;
  }

  state.selectedCardId = null;
  renderModal();
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
