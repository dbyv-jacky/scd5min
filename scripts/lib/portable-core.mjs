export function buildRuntimeBoardData(rawFeed, inputConfig) {
  const config = normalizeBoardConfig(inputConfig);
  const feed = normalizeReferenceFeed(rawFeed);
  const availablePlatforms = getAvailablePlatforms(feed.posts, config);
  const visibleCards = limitPosts(sortPosts(filterPosts(feed.posts, config), config.sort), config.limit.totalItems).map((post) =>
    createRuntimeCard(post, feed.rawPostMap.get(post.id), config)
  );
  const sourceHealth = buildSourceTrafficLights(feed.results);

  return {
    generatedAt: new Date().toISOString(),
    collectedAt: feed.raw.collectedAt || "",
    board: {
      id: config.id,
      name: config.name
    },
    config,
    feedStatus: summarizeFeedHealth(sourceHealth),
    sourceHealth,
    platforms: availablePlatforms,
    cards: visibleCards
  };
}

export function normalizeReferenceFeed(rawFeed) {
  const raw = normalizeFeedDocument(rawFeed);
  const sourceMap = new Map();
  const rawPostMap = new Map();

  raw.results.forEach((result) => {
    buildResultLookupKeys(result).forEach((key) => sourceMap.set(key, result));
  });
  raw.posts.forEach((post) => rawPostMap.set(post.id, post));

  const posts = raw.posts
    .map((post) => normalizeCollectedPost(post, sourceMap))
    .sort((left, right) => getTimestamp(right.takenAt) - getTimestamp(left.takenAt));

  return {
    raw,
    posts,
    results: raw.results,
    rawPostMap
  };
}

export function buildSourceTrafficLights(results) {
  return (Array.isArray(results) ? results : []).map((result) => {
    const postsFound = Array.isArray(result.posts) ? result.posts.length : 0;
    const postsRenderable = (Array.isArray(result.posts) ? result.posts : []).filter(
      (post) => Boolean(post.id && (post.imageUrl || post.videoUrl || post.excerpt || post.title))
    ).length;
    const fetchStatus = result?.diagnostics?.fetchStatus ?? null;
    const hasFetchError = fetchStatus
      ? Object.values(fetchStatus).some(
          (entry) => typeof entry === "object" && entry !== null && "status" in entry && entry.status === "error"
        )
      : false;

    let status = "green";

    if (result.status === "error" || postsRenderable === 0) {
      status = "red";
    } else if (result.status === "partial" || hasFetchError || (result.warnings || []).length > 0) {
      status = "yellow";
    }

    return {
      sourceId: `${result.platform}:${result.source}`,
      label: result.account?.name || result.account?.username || result.source,
      platform: result.platform,
      status,
      rawSourceStatus: result.status,
      postsFound,
      postsRenderable,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      fetchStatus,
      fallbackApplied: Boolean(result.fallbackApplied)
    };
  });
}

export function summarizeFeedHealth(lights) {
  if ((lights || []).some((light) => light.status === "red")) {
    return "red";
  }

  if ((lights || []).some((light) => light.status === "yellow")) {
    return "yellow";
  }

  return "green";
}

export function createRuntimeCard(post, rawPost, config) {
  const media = buildRuntimeMedia(post, rawPost);

  return {
    id: post.id,
    platform: post.platform,
    sourceName: post.sourceName,
    sourceUsername: post.sourceUsername,
    authorName: post.authorName,
    authorAvatarUrl: post.authorAvatarUrl,
    authorAvatarRemoteUrl: rawPost?.accountAvatarRemoteUrl || "",
    dateLabel: formatDate(post.takenAt),
    takenAt: post.takenAt,
    title: post.title || post.previewText || "Untitled Post",
    excerpt: post.previewText || post.text || "No excerpt available for this post.",
    text: post.text || post.previewText || "",
    postType: post.canonicalPostType,
    permalink: post.permalink,
    metrics: post.metrics,
    media,
    fallbackApplied: Boolean(post.sourceDiagnostics?.fallbackApplied),
    rawStatus: post.sourceDiagnostics?.rawStatus || "ok",
    display: {
      sourceStyle: config.card.sourceStyle,
      showAuthorName: config.card.showAuthorName,
      showAuthorPicture: config.card.showAuthorPicture,
      showDate: config.card.showDate,
      showActionsBar: config.card.showActionsBar,
      showSource: config.card.showSource,
      showLikes: config.card.showLikes,
      showComments: config.card.showComments,
      showShares: config.card.showShares,
      textPreviewLines: config.card.textPreviewLines,
      videoAutoplay: config.card.videoAutoplay
    }
  };
}

function normalizeBoardConfig(config) {
  const source = typeof config === "object" && config !== null ? config : {};

  return {
    id: cleanString(source.id) || "board",
    name: cleanString(source.name) || "Board",
    collector: {
      instagramUsernames: normalizeStringList(source.collector?.instagramUsernames),
      facebookPages: normalizeStringList(source.collector?.facebookPages),
      perSourceLimit: normalizePositiveInt(source.collector?.perSourceLimit, 6)
    },
    header: {
      title: cleanString(source.header?.title) || "Latest Social Board",
      caption: cleanString(source.header?.caption) || "",
      showTabs: normalizeBoolean(source.header?.showTabs, true),
      groupSourcesByPlatform: normalizeBoolean(source.header?.groupSourcesByPlatform, true)
    },
    filters: {
      platforms: normalizeStringList(source.filters?.platforms),
      postTypes: normalizeStringList(source.filters?.postTypes),
      keywords: normalizeStringList(source.filters?.keywords),
      includeHashtags: normalizeStringList(source.filters?.includeHashtags),
      excludeHashtags: normalizeStringList(source.filters?.excludeHashtags),
      dateFrom: cleanString(source.filters?.dateFrom),
      dateTo: cleanString(source.filters?.dateTo)
    },
    sort: {
      field: normalizeSortField(source.sort?.field),
      direction: normalizeSortDirection(source.sort?.direction)
    },
    manualPosts: {
      pinnedPostIds: normalizeStringList(source.manualPosts?.pinnedPostIds),
      forcedIncludePostIds: normalizeStringList(source.manualPosts?.forcedIncludePostIds),
      forcedExcludePostIds: normalizeStringList(source.manualPosts?.forcedExcludePostIds),
      hiddenPostIds: normalizeStringList(source.manualPosts?.hiddenPostIds)
    },
    limit: {
      totalItems: normalizePositiveInt(source.limit?.totalItems, 12),
      itemsPerPage: normalizePositiveInt(source.limit?.itemsPerPage, 12),
      itemsPerPageMobile: normalizePositiveInt(source.limit?.itemsPerPageMobile, 4),
      loadMoreEnabled: normalizeBoolean(source.limit?.loadMoreEnabled, true)
    },
    layout: {
      mode: normalizeLayoutMode(source.layout?.mode),
      columns: normalizeClampedInt(source.layout?.columns, 3, 1, 6),
      itemSpacing: normalizeClampedInt(source.layout?.itemSpacing, 18, 4, 48)
    },
    card: {
      showAuthorName: normalizeBoolean(source.card?.showAuthorName, true),
      showAuthorPicture: normalizeBoolean(source.card?.showAuthorPicture, true),
      showDate: normalizeBoolean(source.card?.showDate, true),
      showActionsBar: normalizeBoolean(source.card?.showActionsBar, true),
      showText: normalizeBoolean(source.card?.showText, true),
      showSource: normalizeBoolean(source.card?.showSource, true),
      sourceStyle: normalizeSourceStyle(source.card?.sourceStyle),
      showLikes: normalizeBoolean(source.card?.showLikes, true),
      showComments: normalizeBoolean(source.card?.showComments, true),
      showShares: normalizeBoolean(source.card?.showShares, true),
      videoAutoplay: normalizeBoolean(source.card?.videoAutoplay, true),
      textPreviewLines: normalizeClampedInt(source.card?.textPreviewLines, 3, 1, 8)
    },
    interaction: {
      enableExternalLinks: normalizeBoolean(source.interaction?.enableExternalLinks, true),
      openLinksInNewTab: normalizeBoolean(source.interaction?.openLinksInNewTab, true),
      onPostClick: normalizeClickMode(source.interaction?.onPostClick)
    },
    style: {
      theme: normalizeTheme(source.style?.theme),
      accentColor: normalizeHexColor(source.style?.accentColor, "#da5d36"),
      fontFamily: cleanString(source.style?.fontFamily) || "Manrope",
      customCss: cleanString(source.style?.customCss)
    }
  };
}

function normalizeFeedDocument(rawFeed) {
  const feed = typeof rawFeed === "object" && rawFeed !== null ? rawFeed : {};

  return {
    collectedAt: cleanString(feed.collectedAt),
    engine: {
      name: cleanString(feed.engine?.name) || "public-social-content-collector",
      version: cleanString(feed.engine?.version) || "unknown"
    },
    summary: {
      sourcesRequested: normalizePositiveInt(feed.summary?.sourcesRequested, 0),
      sourcesCollected: normalizePositiveInt(feed.summary?.sourcesCollected, 0),
      fullySupportedSources: normalizePositiveInt(feed.summary?.fullySupportedSources, 0),
      partialSources: normalizePositiveInt(feed.summary?.partialSources, 0),
      postsCollected: normalizePositiveInt(feed.summary?.postsCollected, Array.isArray(feed.posts) ? feed.posts.length : 0)
    },
    results: Array.isArray(feed.results) ? feed.results.map(normalizeResult) : [],
    posts: Array.isArray(feed.posts) ? feed.posts.map(normalizeRawPost) : []
  };
}

function normalizeResult(result) {
  const source = typeof result === "object" && result !== null ? result : {};

  return {
    platform: cleanString(source.platform),
    source: cleanString(source.source),
    status: normalizeResultStatus(source.status),
    warnings: Array.isArray(source.warnings) ? source.warnings.map(cleanString).filter(Boolean) : [],
    diagnostics: typeof source.diagnostics === "object" && source.diagnostics !== null ? source.diagnostics : {},
    account: typeof source.account === "object" && source.account !== null ? source.account : null,
    posts: Array.isArray(source.posts) ? source.posts.map(normalizeRawPost) : [],
    fallbackApplied: Boolean(source.fallbackApplied)
  };
}

function normalizeRawPost(post) {
  const source = typeof post === "object" && post !== null ? post : {};

  return {
    id: cleanString(source.id),
    platform: cleanString(source.platform),
    accountName: cleanString(source.accountName) || cleanString(source.platform),
    accountUsername: cleanString(source.accountUsername),
    takenAt: cleanString(source.takenAt),
    title: cleanString(source.title),
    excerpt: cleanString(source.excerpt),
    mediaType: cleanString(source.mediaType),
    imageUrl: cleanString(source.imageUrl),
    remoteImageUrl: cleanString(source.remoteImageUrl),
    videoThumbnailUrl: cleanString(source.videoThumbnailUrl),
    videoUrl: cleanString(source.videoUrl),
    mediaWidth: normalizeNullableNumber(source.mediaWidth),
    mediaHeight: normalizeNullableNumber(source.mediaHeight),
    permalink: cleanString(source.permalink),
    likeCount: normalizeNullableNumber(source.likeCount),
    commentCount: normalizeNullableNumber(source.commentCount),
    shareCount: normalizeNullableNumber(source.shareCount),
    sourcePayload: typeof source.sourcePayload === "object" && source.sourcePayload !== null ? source.sourcePayload : {}
  };
}

function normalizeCollectedPost(post, sourceMap) {
  const sourceId = getSourceId(post.platform, post.accountUsername || post.accountName);
  const matchedResult =
    sourceMap.get(sourceId) ||
    sourceMap.get(getSourceId(post.platform, post.accountName)) ||
    sourceMap.get(getSourceId(post.platform, post.platform === "facebook" ? post.permalink : post.accountUsername));
  const sourcePayload = post.sourcePayload || {};
  const combinedText = buildCombinedText(post, sourcePayload);
  const hashtags = extractHashtags(combinedText);
  const likes = normalizeMetric(post.likeCount);
  const comments = normalizeMetric(post.commentCount);
  const shares = normalizeMetric(post.shareCount);

  return {
    id: post.id,
    platform: post.platform,
    sourceId,
    sourceName: matchedResult?.account?.name || post.accountName || post.platform,
    sourceUsername: post.accountUsername || matchedResult?.account?.username || "",
    authorName: post.accountName || matchedResult?.account?.name || post.platform,
    authorAvatarUrl: resolveAuthorAvatarUrl(
      matchedResult?.account?.profileImageUrl,
      matchedResult?.account?.remoteProfileImageUrl
    ),
    authorAvatarRemoteUrl: cleanString(matchedResult?.account?.remoteProfileImageUrl),
    permalink: post.permalink || "",
    takenAt: post.takenAt || "",
    title: post.title || "",
    text: combinedText,
    previewText: post.excerpt || post.title || "",
    hashtags,
    canonicalPostType: inferPostType(post.platform, post.mediaType, sourcePayload),
    media: buildCanonicalMedia(post),
    metrics: {
      likes,
      comments,
      shares,
      engagement: likes + comments * 2 + shares * 3
    },
    sourcePayload,
    sourceDiagnostics: {
      rawStatus: matchedResult?.status || "ok",
      fallbackApplied: Boolean(matchedResult?.fallbackApplied)
    }
  };
}

function buildCanonicalMedia(post) {
  const imageUrl = resolvePreferredMediaUrl(post.imageUrl, post.remoteImageUrl);
  const thumbnailUrl =
    resolvePreferredMediaUrl(post.videoThumbnailUrl, post.imageUrl) ||
    resolvePreferredMediaUrl(post.videoThumbnailUrl, post.remoteImageUrl);

  if (post.videoUrl) {
    return [
      {
        kind: "video",
        url: post.videoUrl,
        thumbnailUrl,
        width: post.mediaWidth,
        height: post.mediaHeight
      }
    ];
  }

  if (imageUrl) {
    return [
      {
        kind: "image",
        url: imageUrl,
        thumbnailUrl: imageUrl,
        width: post.mediaWidth,
        height: post.mediaHeight
      }
    ];
  }

  return [];
}

function buildRuntimeMedia(post, rawPost) {
  const canonicalMedia = post.media[0] || null;
  const primaryUrl = canonicalMedia?.thumbnailUrl || canonicalMedia?.url || "";
  const remoteImageUrl = cleanString(rawPost?.remoteImageUrl);
  const remoteFallbackUrl =
    canonicalMedia?.kind === "video"
      ? cleanString(rawPost?.videoThumbnailUrl) || remoteImageUrl
      : remoteImageUrl && remoteImageUrl !== primaryUrl
        ? remoteImageUrl
        : "";

  if (!canonicalMedia) {
    return null;
  }

  return {
    kind: canonicalMedia.kind,
    url: cleanString(canonicalMedia.url),
    thumbnailUrl: cleanString(canonicalMedia.thumbnailUrl || canonicalMedia.url),
    remoteUrl: remoteFallbackUrl,
    width: canonicalMedia.width ?? null,
    height: canonicalMedia.height ?? null
  };
}

function getAvailablePlatforms(posts, config) {
  const filtered = posts.filter((post) => {
    if (config.manualPosts.hiddenPostIds.includes(post.id) || config.manualPosts.forcedExcludePostIds.includes(post.id)) {
      return false;
    }

    if (config.filters.postTypes.length > 0 && !config.filters.postTypes.includes(post.canonicalPostType)) {
      return false;
    }

    if (config.filters.keywords.length > 0) {
      const haystack = `${post.title} ${post.text} ${post.previewText}`.toLowerCase();
      if (!config.filters.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
        return false;
      }
    }

    if (config.filters.includeHashtags.length > 0 && !config.filters.includeHashtags.some((tag) => matchesHashtagFilter(post, tag))) {
      return false;
    }

    if (config.filters.excludeHashtags.length > 0 && config.filters.excludeHashtags.some((tag) => matchesHashtagFilter(post, tag))) {
      return false;
    }

    if (config.filters.dateFrom && getTimestamp(post.takenAt) < getTimestamp(config.filters.dateFrom)) {
      return false;
    }

    if (config.filters.dateTo) {
      const toDate = new Date(config.filters.dateTo);
      toDate.setHours(23, 59, 59, 999);
      if (getTimestamp(post.takenAt) > toDate.getTime()) {
        return false;
      }
    }

    if (config.filters.platforms.length > 0 && !config.filters.platforms.includes(post.platform)) {
      return false;
    }

    return true;
  });

  return Array.from(new Set(filtered.map((post) => post.platform))).filter(Boolean);
}

function filterPosts(posts, config) {
  return posts.filter((post) => {
    if (config.manualPosts.hiddenPostIds.includes(post.id) || config.manualPosts.forcedExcludePostIds.includes(post.id)) {
      return false;
    }

    if (config.manualPosts.forcedIncludePostIds.includes(post.id)) {
      return true;
    }

    if (config.filters.platforms.length > 0 && !config.filters.platforms.includes(post.platform)) {
      return false;
    }

    if (config.filters.postTypes.length > 0 && !config.filters.postTypes.includes(post.canonicalPostType)) {
      return false;
    }

    if (config.filters.keywords.length > 0) {
      const haystack = `${post.title} ${post.text} ${post.previewText}`.toLowerCase();
      if (!config.filters.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
        return false;
      }
    }

    if (config.filters.includeHashtags.length > 0 && !config.filters.includeHashtags.some((tag) => matchesHashtagFilter(post, tag))) {
      return false;
    }

    if (config.filters.excludeHashtags.length > 0 && config.filters.excludeHashtags.some((tag) => matchesHashtagFilter(post, tag))) {
      return false;
    }

    if (config.filters.dateFrom && getTimestamp(post.takenAt) < getTimestamp(config.filters.dateFrom)) {
      return false;
    }

    if (config.filters.dateTo) {
      const toDate = new Date(config.filters.dateTo);
      toDate.setHours(23, 59, 59, 999);
      if (getTimestamp(post.takenAt) > toDate.getTime()) {
        return false;
      }
    }

    return true;
  });
}

function sortPosts(posts, sortConfig) {
  const direction = sortConfig.direction === "asc" ? 1 : -1;
  return [...posts].sort((left, right) => {
    const leftValue = getSortValue(left, sortConfig.field);
    const rightValue = getSortValue(right, sortConfig.field);

    if (leftValue !== rightValue) {
      return (leftValue - rightValue) * direction;
    }

    return (getTimestamp(left.takenAt) - getTimestamp(right.takenAt)) * direction;
  });
}

function limitPosts(posts, limit) {
  return posts.slice(0, limit);
}

function getSortValue(post, field) {
  if (field === "likes") {
    return post.metrics.likes;
  }

  if (field === "comments") {
    return post.metrics.comments;
  }

  if (field === "shares") {
    return post.metrics.shares;
  }

  if (field === "engagement") {
    return post.metrics.engagement;
  }

  return getTimestamp(post.takenAt);
}

function normalizeLayoutMode(value) {
  return ["grid", "masonry", "list"].includes(value) ? value : "masonry";
}

function normalizeSourceStyle(value) {
  return ["icon", "text", "icon-text"].includes(value) ? value : "icon-text";
}

function normalizeClickMode(value) {
  return ["popup", "new-tab", "disabled"].includes(value) ? value : "popup";
}

function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function normalizeSortField(value) {
  return ["recency", "likes", "comments", "shares", "engagement"].includes(value) ? value : "recency";
}

function normalizeSortDirection(value) {
  return value === "asc" ? "asc" : "desc";
}

function normalizeResultStatus(value) {
  return ["ok", "partial", "error"].includes(value) ? value : "error";
}

function buildResultLookupKeys(result) {
  return Array.from(
    new Set(
      [result.source, result.account?.username, result.account?.name]
        .map((value) => getSourceId(result.platform, value))
        .filter((value) => value !== `${result.platform}:`)
    )
  );
}

function inferPostType(platform, mediaType, sourcePayload) {
  const productType = cleanString(sourcePayload?.productType).toLowerCase();

  if (platform === "instagram" && productType === "clips") {
    return "reel";
  }

  if (productType === "carousel_container") {
    return "carousel";
  }

  if (mediaType === "video") {
    return "video";
  }

  if (mediaType === "image") {
    return "image";
  }

  return "post";
}

function buildCombinedText(post, sourcePayload) {
  return [post.title || "", post.excerpt || "", extractSourcePayloadText(sourcePayload)]
    .map((value) => cleanString(value))
    .filter(Boolean)
    .join(" ");
}

function extractSourcePayloadText(sourcePayload) {
  if (!sourcePayload || typeof sourcePayload !== "object") {
    return "";
  }

  const collected = new Set();
  collectTextualPayloadValues(sourcePayload, collected);
  return Array.from(collected).join(" ");
}

function collectTextualPayloadValues(value, collected, keyHint = "", depth = 0) {
  if (depth > 4) {
    return;
  }

  if (typeof value === "string") {
    const trimmedValue = cleanString(value);

    if (!trimmedValue) {
      return;
    }

    if (keyHint && /(caption|message|text|description|accessibility|body|content|alt)/i.test(keyHint)) {
      collected.add(trimmedValue);
      return;
    }

    if (trimmedValue.includes("#")) {
      collected.add(trimmedValue);
    }

    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectTextualPayloadValues(entry, collected, keyHint, depth + 1));
    return;
  }

  if (typeof value === "object" && value !== null) {
    Object.entries(value).forEach(([key, entry]) => collectTextualPayloadValues(entry, collected, key, depth + 1));
  }
}

function extractHashtags(value) {
  return Array.from(new Set((String(value || "").match(/#([\p{L}\p{N}_]+)/gu) || []).map((item) => item.slice(1).toLowerCase())));
}

function matchesHashtagFilter(post, tag) {
  const normalizedTag = cleanString(tag).replace(/^#/, "").toLowerCase();
  return post.hashtags.includes(normalizedTag) || post.text.toLowerCase().includes(`#${normalizedTag}`);
}

function resolvePreferredMediaUrl(primaryValue, fallbackValue) {
  const primary = cleanString(primaryValue);
  return primary || cleanString(fallbackValue);
}

function resolveAuthorAvatarUrl(profileImageUrl, remoteProfileImageUrl) {
  const profileImage = cleanString(profileImageUrl);
  const remoteImage = cleanString(remoteProfileImageUrl);

  if (profileImage) {
    return profileImage;
  }

  return remoteImage;
}

function formatDate(value) {
  if (!value) {
    return "Unknown date";
  }

  const date = new Date(value);

  if (Number.isNaN(date.valueOf())) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(date);
}

function normalizeMetric(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizePositiveInt(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : fallback;
}

function normalizeNullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeClampedInt(value, fallback, min, max) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function normalizeStringList(value) {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function normalizeHexColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(cleanString(value)) ? cleanString(value) : fallback;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getTimestamp(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.valueOf()) ? 0 : date.getTime();
}

function getSourceId(platform, source) {
  return `${platform}:${cleanString(source)}`;
}
