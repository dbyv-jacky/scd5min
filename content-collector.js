const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), "collector.config.json");
const DEFAULT_SAMPLE_FEED_PATH = path.join(process.cwd(), "collected-feed.test.json");
const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "zh-HK,zh-TW;q=0.9,en;q=0.8"
};
const INSTAGRAM_APP_ID = "936619743392459";
const FETCH_TIMEOUT_MS = 8000;

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = await generateFeed({
    configPath: args.configPath || DEFAULT_CONFIG_PATH,
    outputPath: args.outputPath,
    productionFeedUrl: args.productionFeedUrl || process.env.PRODUCTION_FEED_URL || process.env.PRODUCTION_SITE_URL || "",
    sampleFeedPath: args.sampleFeedPath || DEFAULT_SAMPLE_FEED_PATH
  });

  const outputPath = args.outputPath
    ? path.resolve(args.outputPath)
    : path.resolve(process.cwd(), "collected-feed.test.json");

  console.log(`Saved collector output to ${outputPath}`);
  console.log(
    JSON.stringify(
      {
        summary: payload.summary,
        sources: payload.results.map((item) => ({
          platform: item.platform,
          source: item.source,
          status: item.status,
          posts: item.posts.length,
          fallbackApplied: Boolean(item.fallbackApplied)
        }))
      },
      null,
      2
    )
  );
}

async function generateFeed(options = {}) {
  const fetchImpl = getFetchImplementation(options.fetchImpl);
  const configPath = path.resolve(options.configPath || DEFAULT_CONFIG_PATH);
  const config = await readJson(configPath);
  const perSourceLimit = Number(config.perSourceLimit || 6);
  const excludedHashtagFilters = normalizeHashtagFilterValues(config.excludedHashtags || []);
  const rootDir = path.dirname(configPath);
  const outputPath = path.resolve(options.outputPath || path.join(rootDir, config.outputFile || "collected-feed.test.json"));
  const cacheDir = path.resolve(options.cacheDir || path.join(rootDir, config.cacheDir || ".collector-cache"));

  await fs.mkdir(cacheDir, { recursive: true });

  const fallbackPayloads = await loadFallbackPayloads({
    fetchImpl,
    productionFeedUrl: normalizeProductionFeedUrl(options.productionFeedUrl || ""),
    sampleFeedPath: path.resolve(options.sampleFeedPath || DEFAULT_SAMPLE_FEED_PATH)
  });
  const fallbackSourceMap = buildFallbackSourceMap(fallbackPayloads);

  const collectedResults = [];

  for (const username of config.instagram || []) {
    collectedResults.push(await collectInstagramUsername(username, perSourceLimit, cacheDir, fetchImpl, excludedHashtagFilters));
  }

  for (const url of config.facebook || []) {
    collectedResults.push(await collectFacebookPage(url, perSourceLimit, cacheDir, fetchImpl));
  }

  const unfilteredResults = await Promise.all(
    collectedResults.map((result) =>
      applyFallbackToResult(result, fallbackSourceMap.get(getSourceKey(result)), {
        cacheDir,
        fetchImpl
      })
    )
  );
  const results = unfilteredResults.map((result) => applyHashtagFiltersToResult(result, excludedHashtagFilters));
  const allPosts = sortPostsByDate(results.flatMap((result) => result.posts || []));
  const summary = {
    sourcesRequested: results.length,
    sourcesCollected: results.filter((item) => item.status === "ok" || item.status === "partial").length,
    fullySupportedSources: results.filter((item) => item.status === "ok").length,
    partialSources: results.filter((item) => item.status === "partial").length,
    postsCollected: allPosts.length
  };

  const payload = {
    collectedAt: new Date().toISOString(),
    engine: {
      name: "public-social-content-collector",
      version: "0.2.0"
    },
    summary,
    results,
    posts: allPosts
  };

  await writeJson(outputPath, payload);

  return payload;
}

async function loadFallbackPayloads({ fetchImpl, productionFeedUrl, sampleFeedPath }) {
  const entries = [];

  if (productionFeedUrl) {
    const livePayload = await fetchJsonIfAvailable(fetchImpl, productionFeedUrl);

    if (livePayload) {
      entries.push({ label: "previous-live-feed", payload: livePayload });
    }
  }

  const samplePayload = await readJsonIfExists(sampleFeedPath);

  if (samplePayload) {
    entries.push({ label: "sample-feed", payload: samplePayload });
  }

  return entries;
}

function buildFallbackSourceMap(entries) {
  const map = new Map();

  for (const entry of entries) {
    if (!entry?.payload || !Array.isArray(entry.payload.results)) {
      continue;
    }

    for (const result of entry.payload.results) {
      const key = getSourceKey(result);

      if (!key || map.has(key) || !hasRenderableSourceData(result)) {
        continue;
      }

      map.set(
        key,
        Object.assign(cloneJson(result), {
          __fallbackLabel: entry.label
        })
      );
    }
  }

  return map;
}

async function applyFallbackToResult(result, fallbackSource, options = {}) {
  if (!needsFallback(result) || !fallbackSource) {
    return repairFacebookSourceMedia(result, options);
  }

  const fallback = cloneJson(fallbackSource);
  const fallbackLabel = fallback.__fallbackLabel || "stored-fallback";
  delete fallback.__fallbackLabel;

  const fallbackResult = {
    ...fallback,
    platform: result.platform,
    source: result.source,
    status: "partial",
    warnings: dedupeStrings([
      ...(fallback.warnings || []),
      ...(result.warnings || []),
      `Reused last good snapshot from ${fallbackLabel} because the latest fetch returned no displayable posts.`
    ]),
    diagnostics: {
      ...(fallback.diagnostics || {}),
      fallbackApplied: {
        from: fallbackLabel,
        at: new Date().toISOString(),
        reason: result.error || `Current run returned ${result.posts?.length || 0} posts.`
      },
      latestAttempt: {
        status: result.status,
        error: result.error || null,
        warnings: result.warnings || [],
        diagnostics: result.diagnostics || {}
      }
    },
    fallbackApplied: true
  };

  return repairFacebookSourceMedia(fallbackResult, options);
}

function needsFallback(result) {
  if (!result) {
    return false;
  }

  if (result.status === "error") {
    return true;
  }

  return !Array.isArray(result.posts) || result.posts.length === 0;
}

function hasRenderableSourceData(result) {
  return Boolean(result && (result.account || (Array.isArray(result.posts) && result.posts.length > 0)));
}

function getSourceKey(result) {
  if (!result?.platform || !result?.source) {
    return "";
  }

  return `${result.platform}:${result.source}`;
}

async function collectInstagramUsername(username, limit, cacheDir, fetchImpl, excludedHashtags = new Set()) {
  const profileUrl = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  const reelsUrl = `https://www.instagram.com/${encodeURIComponent(username)}/reels/`;
  const profileApiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const reelsApiUrl = "https://www.instagram.com/api/v1/clips/user/";
  const timelineFetchCount = getInstagramTimelineFetchCount(limit);
  const timelineApiUrl = `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=${encodeURIComponent(
    String(timelineFetchCount)
  )}`;
  const profileCachePath = path.join(cacheDir, `instagram-${username}-profile.json`);
  const timelineCachePath = path.join(cacheDir, `instagram-${username}-timeline.json`);
  const reelsCachePath = path.join(cacheDir, `instagram-${username}-reels.json`);
  const requestHeaders = {
    ...DEFAULT_HEADERS,
    accept: "*/*",
    referer: profileUrl,
    "x-ig-app-id": INSTAGRAM_APP_ID,
    "x-requested-with": "XMLHttpRequest"
  };

  const [profileResult, timelineResult] = await Promise.allSettled([
    fetchJsonDocument(fetchImpl, profileApiUrl, {
      headers: requestHeaders,
      cachePath: profileCachePath
    }),
    fetchJsonDocument(fetchImpl, timelineApiUrl, {
      headers: requestHeaders,
      cachePath: timelineCachePath
    })
  ]);

  const profileJson = profileResult.status === "fulfilled" ? profileResult.value : null;
  let timelineJson = timelineResult.status === "fulfilled" ? timelineResult.value : null;
  const profileError = profileResult.status === "rejected" ? getErrorMessage(profileResult.reason) : null;
  const timelineError = timelineResult.status === "rejected" ? getErrorMessage(timelineResult.reason) : null;
  let cachedTimelineUsed = false;
  let timelineSource = "live";
  let timelineItems = Array.isArray(timelineJson?.items) ? timelineJson.items : [];
  const warnings = [];
  let cachedProfileUsed = false;
  let profileSource = "live";
  let user = profileJson?.data?.user || null;

  if (!user && profileError) {
    const cachedProfileJson = await readJsonIfExists(profileCachePath);

    if (cachedProfileJson?.data?.user) {
      user = cachedProfileJson.data.user;
      cachedProfileUsed = true;
      profileSource = "cache";
      warnings.push(`Instagram profile metadata reused from cache because the live profile request failed: ${profileError}`);
    }
  }

  if (!timelineItems.length && timelineError) {
    const cachedTimelineJson = await readJsonIfExists(timelineCachePath);

    if (Array.isArray(cachedTimelineJson?.items) && cachedTimelineJson.items.length) {
      timelineJson = cachedTimelineJson;
      timelineItems = cachedTimelineJson.items;
      cachedTimelineUsed = true;
      timelineSource = "cache";
      warnings.push(`Instagram timeline reused from cache because the live request failed: ${timelineError}`);
    }
  }

  if (!user) {
    user = resolveInstagramUserFromTimeline(username, timelineItems);

    if (user) {
      profileSource = "timeline";
      warnings.push(
        profileError
          ? `Instagram profile request failed (${profileError}), so account details were inferred from timeline items.`
          : "Instagram profile metadata was unavailable, so account details were inferred from timeline items."
      );
    }
  }

  let reelsError = null;
  let reelsItems = [];
  let cachedReelsUsed = false;
  let reelsSource = "live";

  if (user?.id) {
    try {
      const reelsJson = await fetchInstagramReelsFeed(fetchImpl, {
        username,
        userId: user.id,
        pageSize: timelineFetchCount,
        reelsUrl,
        reelsApiUrl,
        cachePath: reelsCachePath
      });
      reelsItems = extractInstagramReelsItems(reelsJson);
    } catch (error) {
      reelsError = getErrorMessage(error);

      const cachedReelsJson = await readJsonIfExists(reelsCachePath);

      if (cachedReelsJson) {
        reelsItems = extractInstagramReelsItems(cachedReelsJson);

        if (reelsItems.length) {
          cachedReelsUsed = true;
          reelsSource = "cache";
          warnings.push(`Instagram reels tab reused from cache because the live request failed: ${reelsError}`);
        } else {
          warnings.push(`Instagram reels tab request failed: ${reelsError}`);
        }
      } else {
        warnings.push(`Instagram reels tab request failed: ${reelsError}`);
      }
    }
  }

  const eligibleInstagramItems = filterInstagramItemsByHashtags(mergeInstagramItems(timelineItems, reelsItems), excludedHashtags);
  const displayItems = selectInstagramDisplayItems(eligibleInstagramItems, limit);

  const avatarInfo = user
    ? await ensureInstagramAvatarCached({
        user,
        username,
        cacheDir,
        fetchImpl,
        referer: profileUrl
      })
    : null;

  if (!displayItems.length) {
    return {
      platform: "instagram",
      source: username,
      status: timelineError && reelsError ? "error" : "partial",
      warnings: dedupeStrings([
        ...warnings,
        !timelineError && !reelsError ? "Instagram profile metadata loaded, but Instagram timeline and reels items were empty in this run." : "",
        profileError && !cachedProfileUsed ? `Instagram profile request failed: ${profileError}` : ""
      ]),
      diagnostics: {
        sourceUrl: profileUrl,
        endpoints: {
          profile: profileApiUrl,
          timeline: timelineApiUrl,
          reelsPage: reelsUrl,
          reels: reelsApiUrl
        },
        cache: {
          profile: profileCachePath,
          timeline: timelineCachePath,
          reels: reelsCachePath
        },
        fetchStatus: {
          profile: {
            status: profileError ? "error" : "ok",
            error: profileError,
            source: profileSource,
            cacheUsed: cachedProfileUsed
          },
          timeline: {
            status: timelineError ? "error" : "ok",
            error: timelineError,
            source: timelineSource,
            cacheUsed: cachedTimelineUsed
          },
          reels: {
            status: !user?.id ? "skipped" : reelsError ? "error" : "ok",
            error: reelsError,
            items: reelsItems.length,
            source: reelsSource,
            cacheUsed: cachedReelsUsed
          }
        }
      },
      account: user ? createInstagramAccount(user, username, avatarInfo) : null,
      posts: [],
      error: timelineError || reelsError || null
    };
  }

  const normalizedUser = user || createMinimalInstagramUser(username, displayItems);

  return {
    platform: "instagram",
    source: username,
    status: profileError || timelineError || reelsError ? "partial" : "ok",
    warnings: dedupeStrings([
      ...warnings,
      profileError && !cachedProfileUsed && profileSource === "live" ? `Instagram profile request failed: ${profileError}` : ""
    ]),
    diagnostics: {
      sourceUrl: profileUrl,
      endpoints: {
        profile: profileApiUrl,
        timeline: timelineApiUrl,
        reelsPage: reelsUrl,
        reels: reelsApiUrl
      },
      cache: {
        profile: profileCachePath,
        timeline: timelineCachePath,
        reels: reelsCachePath
      },
      fetchStatus: {
        profile: {
          status: profileError ? "error" : "ok",
          error: profileError,
          source: profileSource,
          cacheUsed: cachedProfileUsed
        },
        timeline: {
          status: timelineError ? "error" : "ok",
          error: timelineError,
          source: timelineSource,
          cacheUsed: cachedTimelineUsed
        },
        reels: {
          status: !user?.id ? "skipped" : reelsError ? "error" : "ok",
          error: reelsError,
          items: reelsItems.length,
          source: reelsSource,
          cacheUsed: cachedReelsUsed
        }
      }
    },
    account: createInstagramAccount(normalizedUser, username, avatarInfo),
    posts: displayItems.map((item) => normalizeInstagramPost(item, normalizedUser))
  };
}

async function collectFacebookPage(url, limit, cacheDir, fetchImpl) {
  const slug = slugifySource(url);
  const htmlCachePath = path.join(cacheDir, `facebook-${slug}.html`);
  const pluginCachePath = path.join(cacheDir, `facebook-${slug}-plugin.html`);
  const pageUrl = url;
  const pluginUrl = `https://www.facebook.com/plugins/page.php?href=${encodeURIComponent(
    url
  )}&tabs=timeline&width=500&height=1200&small_header=false&adapt_container_width=true&hide_cover=false&show_facepile=false&locale=zh_HK&appId`;

  try {
    const [pageResult, pluginResult] = await Promise.allSettled([
      fetchTextDocument(fetchImpl, pageUrl, {
        headers: {},
        cachePath: htmlCachePath
      }),
      fetchTextDocument(fetchImpl, pluginUrl, {
        headers: DEFAULT_HEADERS,
        cachePath: pluginCachePath
      })
    ]);

    const pageHtml = pageResult.status === "fulfilled" ? pageResult.value : null;
    const pluginHtml = pluginResult.status === "fulfilled" ? pluginResult.value : null;
    const availableHtml = pageHtml || pluginHtml;
    const warnings = [];

    if (pageResult.status === "rejected") {
      warnings.push(`Facebook page HTML fetch failed: ${pageResult.reason?.message || "unknown error"}`);
    }

    if (pluginResult.status === "rejected") {
      warnings.push(`Facebook plugin HTML fetch failed: ${pluginResult.reason?.message || "unknown error"}`);
    }

    if (!availableHtml) {
      throw new Error("No Facebook HTML was fetched for this source.");
    }

    const meta = extractMetaTags(availableHtml);
    const description = cleanText(decodeHtmlEntities(meta["og:description"] || meta.description || ""));
    const counts = parseFacebookCounts(description);
    const defaultAccountName = cleanText(
      decodeHtmlEntities(meta["og:title"] || extractFacebookUsername(url) || "Facebook Page")
    );
    const extractedPosts = extractFacebookPostsFromPluginHtml(pluginHtml || "", {
      sourceUrl: url,
      limit,
      defaultAccountName,
      pluginRendered: false
    });
    const hasPosts = extractedPosts.length > 0;
    const topStructured = extractFacebookStructuredPosting(pluginHtml || "", null);
    const accountName = defaultAccountName || topStructured?.authorName || extractFacebookUsername(url) || "Facebook Page";
    const extractionNotes = [];

    if (pageHtml) {
      extractionNotes.push("Open Graph metadata was loaded from the public page HTML response.");
    }

    if (pluginHtml) {
      extractionNotes.push("Non-rendered Facebook plugin HTML was parsed to extract recent post details.");
    }

    if (!hasPosts) {
      extractionNotes.push("No post blocks were detected in the non-rendered Facebook plugin HTML for this run.");
    }

    const facebookResult = {
      platform: "facebook",
      source: url,
      status: hasPosts ? "ok" : "partial",
      warnings: hasPosts ? warnings : [...warnings, "Facebook metadata loaded, but no recent post blocks were parsed."],
      diagnostics: {
        sourceUrl: url,
        endpoints: {
          page: pageUrl,
          plugin: pluginUrl
        },
        cache: {
          html: htmlCachePath,
          plugin: pluginCachePath
        },
        capability: {
          accountMetadata: Boolean(defaultAccountName),
          recentPosts: hasPosts
        },
        extractionNotes
      },
      account: {
        id: extractFacebookProfileId(pageHtml || pluginHtml || ""),
        platform: "facebook",
        username: extractFacebookUsername(url),
        name: accountName,
        biography: description,
        followers: counts.likes ?? topStructured?.followers ?? null,
        following: null,
        postsCount: hasPosts ? extractedPosts.length : null,
        profileImageUrl: meta["og:image"] ? decodeHtmlEntities(meta["og:image"]) : topStructured?.authorImage || null,
        remoteProfileImageUrl: meta["og:image"] ? decodeHtmlEntities(meta["og:image"]) : topStructured?.authorImage || null,
        externalUrl: meta["og:url"] ? decodeHtmlEntities(meta["og:url"]) : url,
        likes: counts.likes,
        talkingAbout: counts.talkingAbout,
        checkins: counts.checkins
      },
      posts: extractedPosts.map((post) => ({
        ...post,
        accountName
      }))
    };

    return repairFacebookSourceMedia(facebookResult, {
      cacheDir,
      fetchImpl,
      pageHtml,
      pluginHtml
    });
  } catch (error) {
    return {
      platform: "facebook",
      source: url,
      status: "error",
      warnings: [],
      diagnostics: {
        sourceUrl: url,
        endpoints: {
          page: pageUrl,
          plugin: pluginUrl
        },
        cache: {
          html: htmlCachePath,
          plugin: pluginCachePath
        }
      },
      account: null,
      posts: [],
      error: error.message
    };
  }
}

async function repairFacebookSourceMedia(result, options = {}) {
  if (!result || result.platform !== "facebook" || !options.cacheDir || !options.fetchImpl) {
    return result;
  }

  const slug = slugifySource(result.source || "facebook");
  const pageMetadata =
    getFacebookOpenGraphMetadataFromHtml(options.pageHtml, result.source) ||
    (result.source ? await fetchFacebookOpenGraphMetadata(options.fetchImpl, result.source).catch(() => null) : null);
  const pluginAvatarUrl = extractFacebookPluginAvatarUrl(options.pluginHtml, result.source);
  const accountImageUrl =
    pageMetadata?.imageUrl || pluginAvatarUrl || normalizeAbsoluteUrl(result.account?.profileImageUrl || "", result.source) || null;
  const cachedAccountImage = await cacheRemoteMedia({
    remoteUrl: accountImageUrl,
    cacheDir: options.cacheDir,
    fileName: getFacebookAccountCacheFileName(slug, accountImageUrl),
    fetchImpl: options.fetchImpl,
    referer: result.source
  });
  const repairedPosts = await Promise.all(
    (result.posts || []).map((post) =>
      repairFacebookPostMedia(post, {
        cacheDir: options.cacheDir,
        fetchImpl: options.fetchImpl,
        slug,
        sourceUrl: result.source
      })
    )
  );

  return {
    ...result,
    account: result.account
      ? {
          ...result.account,
          profileImageUrl: cachedAccountImage.localPath || accountImageUrl || result.account.profileImageUrl || null,
          remoteProfileImageUrl: accountImageUrl || result.account.remoteProfileImageUrl || result.account.profileImageUrl || null
        }
      : result.account,
    posts: repairedPosts
  };
}

async function repairFacebookPostMedia(post, options = {}) {
  if (!post || post.platform !== "facebook") {
    return post;
  }

  const currentRemoteImageUrl = /^https?:\/\//i.test(String(post.imageUrl || "")) ? post.imageUrl : "";
  const cachedCurrentImage = currentRemoteImageUrl
    ? await cacheRemoteMedia({
        remoteUrl: currentRemoteImageUrl,
        cacheDir: options.cacheDir,
        fileName: getFacebookPostCacheFileName(options.slug || "facebook", post.id, currentRemoteImageUrl),
        fetchImpl: options.fetchImpl,
        referer: post.permalink || options.sourceUrl
      })
    : { localPath: "", remoteUrl: "" };
  const permalinkMetadata = post.permalink
    ? await fetchFacebookOpenGraphMetadata(options.fetchImpl, post.permalink).catch(() => null)
    : null;
  const refreshedImageUrl = permalinkMetadata?.imageUrl || currentRemoteImageUrl || null;
  const cachedRefreshedImage = await cacheRemoteMedia({
    remoteUrl: refreshedImageUrl,
    cacheDir: options.cacheDir,
    fileName: getFacebookPostCacheFileName(options.slug || "facebook", post.id, refreshedImageUrl),
    fetchImpl: options.fetchImpl,
    referer: post.permalink || options.sourceUrl
  });

  return {
    ...post,
    imageUrl: cachedRefreshedImage.localPath || cachedCurrentImage.localPath || refreshedImageUrl || post.imageUrl || null,
    remoteImageUrl: refreshedImageUrl || currentRemoteImageUrl || null
  };
}

function normalizeInstagramPost(item, user) {
  const code = item.code || item.shortcode || "";
  const mediaType = getInstagramMediaType(item);
  const imageUrl = getInstagramImageUrl(item);
  const videoUrl = getInstagramVideoUrl(item);
  const mediaDimensions = getInstagramMediaDimensions(item, mediaType);
  const caption = getInstagramCaption(item);
  const hashtags = extractHashtagsFromText(caption);
  const takenAt =
    item.taken_at ??
    item.taken_at_timestamp ??
    (typeof item.device_timestamp === "number" ? Math.floor(item.device_timestamp / 1000000) : null);
  const permalinkBase = mediaType === "video" || item.product_type === "clips" ? "reel" : "p";

  return {
    id: `ig-${item.pk || item.id || code}`,
    type: "social",
    platform: "instagram",
    accountName: user.full_name || user.username,
    accountUsername: user.username,
    timeAgo: null,
    takenAt: takenAt ? new Date(takenAt * 1000).toISOString() : null,
    title: caption ? caption.split("\n")[0].trim().slice(0, 80) : `${user.full_name || user.username} 最新貼文`,
    excerpt: caption ? truncateText(caption.replace(/\s+/g, " ").trim(), 220) : "",
    hashtags,
    mediaType,
    imageUrl,
    videoThumbnailUrl: mediaType === "video" ? imageUrl : null,
    videoUrl,
    mediaWidth: mediaDimensions.width,
    mediaHeight: mediaDimensions.height,
    permalink: code ? `https://www.instagram.com/${permalinkBase}/${code}/` : `https://www.instagram.com/${user.username}/`,
    likeCount:
      item.like_count ??
      item.edge_media_preview_like?.count ??
      item.edge_liked_by?.count ??
      0,
    commentCount: item.comment_count ?? item.edge_media_to_comment?.count ?? 0,
    shareCount: null,
    featured: false,
    tall: false,
    sourcePayload: {
      caption,
      code,
      productType: item.product_type || null,
      isVideo: Boolean(item.video_versions || item.video_url || item.media_type === 2)
    }
  };
}

function getInstagramMediaType(item) {
  if (item.media_type === 2 || item.video_versions || item.video_url || item.product_type === "clips") {
    return "video";
  }

  return "image";
}

function getInstagramImageUrl(item) {
  const candidates = item.image_versions2?.candidates;

  if (Array.isArray(candidates) && candidates.length) {
    return candidates[0].url;
  }

  return (
    item.thumbnail_url ||
    item.thumbnail_src ||
    item.display_url ||
    item.image_versions2?.additional_candidates?.first_frame?.url ||
    null
  );
}

function getInstagramVideoUrl(item) {
  if (item.video_url) {
    return item.video_url;
  }

  if (Array.isArray(item.video_versions) && item.video_versions.length) {
    return item.video_versions[0].url;
  }

  return null;
}

function getInstagramMediaDimensions(item, mediaType) {
  if (mediaType === "video") {
    if (Array.isArray(item.video_versions) && item.video_versions.length) {
      const version = item.video_versions[0];

      return {
        width: normalizePositiveInteger(version.width),
        height: normalizePositiveInteger(version.height)
      };
    }

    return {
      width: normalizePositiveInteger(item.original_width || item.width),
      height: normalizePositiveInteger(item.original_height || item.height)
    };
  }

  const candidates = item.image_versions2?.candidates;

  if (Array.isArray(candidates) && candidates.length) {
    const candidate = candidates[0];

    return {
      width: normalizePositiveInteger(candidate.width),
      height: normalizePositiveInteger(candidate.height)
    };
  }

  return {
    width: normalizePositiveInteger(item.original_width || item.width),
    height: normalizePositiveInteger(item.original_height || item.height)
  };
}

function normalizePositiveInteger(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.round(numberValue) : null;
}

function getErrorMessage(error) {
  if (!error) {
    return null;
  }

  if (typeof error.message === "string" && error.message) {
    return error.message;
  }

  return String(error);
}

function getInstagramTimelineFetchCount(limit) {
  const normalizedLimit = normalizePositiveInteger(limit) || 6;
  return Math.max(normalizedLimit * 2, normalizedLimit + 6, 12);
}

function selectInstagramDisplayItems(items, limit) {
  return selectInstagramTimelineItems(sortInstagramItemsByRecency(items), limit);
}

function selectInstagramTimelineItems(items, limit) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const normalizedLimit = normalizePositiveInteger(limit) || 6;

  if (items.length <= normalizedLimit) {
    return items.slice(0, normalizedLimit);
  }

  const reelIndexes = [];
  const postIndexes = [];

  items.forEach((item, index) => {
    if (item?.product_type === "clips") {
      reelIndexes.push(index);
      return;
    }

    postIndexes.push(index);
  });

  if (!reelIndexes.length || !postIndexes.length) {
    return items.slice(0, normalizedLimit);
  }

  const selectedIndexes = new Set();
  const targetReels = Math.min(reelIndexes.length, Math.ceil(normalizedLimit / 2));
  const targetPosts = Math.min(postIndexes.length, normalizedLimit - targetReels);

  reelIndexes.slice(0, targetReels).forEach((index) => selectedIndexes.add(index));
  postIndexes.slice(0, targetPosts).forEach((index) => selectedIndexes.add(index));

  for (let index = 0; index < items.length && selectedIndexes.size < normalizedLimit; index += 1) {
    selectedIndexes.add(index);
  }

  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => items[index]);
}

function mergeInstagramItems(timelineItems, reelsItems) {
  return dedupeInstagramItems([...(reelsItems || []), ...(timelineItems || [])]);
}

function dedupeInstagramItems(items) {
  const seen = new Set();
  const dedupedItems = [];

  for (const item of items || []) {
    const key = getInstagramItemKey(item);

    if (key && seen.has(key)) {
      continue;
    }

    if (key) {
      seen.add(key);
    }

    dedupedItems.push(item);
  }

  return dedupedItems;
}

function getInstagramItemKey(item) {
  const rawValue = item?.pk || item?.id || item?.code || item?.shortcode || "";
  const key = String(rawValue).trim();
  return key || "";
}

function sortInstagramItemsByRecency(items) {
  return [...(items || [])].sort((left, right) => getInstagramItemTimestamp(right) - getInstagramItemTimestamp(left));
}

function getInstagramItemTimestamp(item) {
  return (
    item?.taken_at ??
    item?.taken_at_timestamp ??
    (typeof item?.device_timestamp === "number" ? Math.floor(item.device_timestamp / 1000000) : 0) ??
    0
  );
}

function extractInstagramReelsItems(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items
    .map((item) => item?.media || null)
    .filter(Boolean);
}

function resolveInstagramUserFromTimeline(username, items) {
  const itemWithUser = Array.isArray(items)
    ? items.find((item) => item?.user || item?.owner)
    : null;
  const candidate = itemWithUser?.user || itemWithUser?.owner;

  if (!candidate) {
    return null;
  }

  return {
    id: candidate.id ?? null,
    username: candidate.username || username,
    full_name: candidate.full_name || candidate.username || username,
    biography: candidate.biography || "",
    edge_followed_by: null,
    edge_follow: null,
    edge_owner_to_timeline_media: null,
    xdt_api__v1__feed__user_timeline_graphql_connection: null,
    profile_pic_url_hd: candidate.profile_pic_url || null,
    profile_pic_url: candidate.profile_pic_url || null,
    external_url: null,
    bio_links: [],
    is_verified: Boolean(candidate.is_verified),
    is_private: Boolean(candidate.is_private)
  };
}

function createMinimalInstagramUser(username, items) {
  return (
    resolveInstagramUserFromTimeline(username, items) || {
      id: null,
      username,
      full_name: username,
      biography: "",
      edge_followed_by: null,
      edge_follow: null,
      edge_owner_to_timeline_media: null,
      xdt_api__v1__feed__user_timeline_graphql_connection: null,
      profile_pic_url_hd: null,
      profile_pic_url: null,
      external_url: null,
      bio_links: [],
      is_verified: false,
      is_private: false
    }
  );
}

function createInstagramAccount(user, fallbackUsername, avatarInfo = null) {
  const remoteAvatarUrl = avatarInfo?.remoteUrl || user?.profile_pic_url_hd || user?.profile_pic_url || null;
  const localAvatarPath = avatarInfo?.localPath || null;

  return {
    id: user?.id ?? null,
    platform: "instagram",
    username: user?.username || fallbackUsername,
    name: user?.full_name || user?.username || fallbackUsername,
    biography: user?.biography || "",
    followers: user?.edge_followed_by?.count ?? null,
    following: user?.edge_follow?.count ?? null,
    postsCount:
      user?.edge_owner_to_timeline_media?.count ??
      user?.xdt_api__v1__feed__user_timeline_graphql_connection?.count ??
      null,
    profileImageUrl: localAvatarPath || remoteAvatarUrl,
    remoteProfileImageUrl: remoteAvatarUrl,
    externalUrl: user?.external_url || null,
    links: Array.isArray(user?.bio_links)
      ? user.bio_links.map((link) => ({
          title: link.title || "",
          url: link.url
        }))
      : [],
    isVerified: Boolean(user?.is_verified),
    isPrivate: Boolean(user?.is_private)
  };
}

async function ensureInstagramAvatarCached({ user, username, cacheDir, fetchImpl, referer }) {
  const remoteUrl = user?.profile_pic_url_hd || user?.profile_pic_url || "";

  if (!remoteUrl) {
    return { localPath: "", remoteUrl: "" };
  }

  const cacheFileName = getInstagramAvatarCacheFileName(username, remoteUrl);

  if (!cacheFileName) {
    return { localPath: "", remoteUrl };
  }

  const localPath = `.collector-cache/${cacheFileName}`;
  const cachePath = path.join(cacheDir, cacheFileName);

  if (!(await fileExists(cachePath))) {
    try {
      await fetchBinaryDocument(fetchImpl, remoteUrl, {
        headers: {
          ...DEFAULT_HEADERS,
          accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          referer
        },
        cachePath
      });
    } catch {
      return { localPath: "", remoteUrl };
    }
  }

  return {
    localPath,
    remoteUrl
  };
}

function getInstagramAvatarCacheFileName(username, remoteUrl) {
  const extension = getMediaExtensionFromUrl(remoteUrl) || ".jpg";
  return `instagram-${username}-avatar${extension}`;
}

function getFacebookAccountCacheFileName(slug, remoteUrl) {
  const extension = getMediaExtensionFromUrl(remoteUrl) || ".jpg";
  return `facebook-${slug}-avatar${extension}`;
}

function getFacebookPostCacheFileName(slug, postId, remoteUrl) {
  const extension = getMediaExtensionFromUrl(remoteUrl) || ".jpg";
  return `facebook-${slug}-${sanitizeFileToken(postId || "post")}${extension}`;
}

function getMediaExtensionFromUrl(value) {
  try {
    const pathname = new URL(value).pathname || "";
    const match = pathname.match(/\.(avif|gif|jpe?g|png|svg|webp)$/i);
    return match ? `.${match[1].toLowerCase()}`.replace(".jpeg", ".jpg") : "";
  } catch {
    return "";
  }
}

function getInstagramCaption(item) {
  if (typeof item.caption === "string") {
    return item.caption;
  }

  if (item.caption?.text) {
    return item.caption.text;
  }

  const edgeCaption = item.edge_media_to_caption?.edges?.[0]?.node?.text;
  return edgeCaption || "";
}

function filterInstagramItemsByHashtags(items, excludedHashtags) {
  if (!excludedHashtags?.size) {
    return items;
  }

  return (items || []).filter((item) => {
    const hashtags = extractHashtagsFromText(getInstagramCaption(item));
    return !hashtags.some((hashtag) => excludedHashtags.has(String(hashtag || "").toLocaleLowerCase("zh-HK")));
  });
}

function extractHashtagsFromText(value) {
  const seen = new Set();
  const hashtags = [];
  const matches = String(value || "").match(/[#＃][\p{L}\p{N}_]+/gu) || [];

  for (const match of matches) {
    const hashtag = normalizeHashtagToken(match);
    const key = hashtag.toLocaleLowerCase("zh-HK");

    if (!hashtag || seen.has(key)) {
      continue;
    }

    seen.add(key);
    hashtags.push(hashtag);
  }

  return hashtags;
}

function normalizeHashtagFilterValues(values) {
  const normalized = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const hashtag = normalizeHashtagToken(value);

    if (!hashtag) {
      continue;
    }

    normalized.add(hashtag.toLocaleLowerCase("zh-HK"));
  }

  return normalized;
}

function normalizeHashtagToken(value) {
  const hashtag = String(value || "").trim();

  if (!hashtag) {
    return "";
  }

  return `#${hashtag.replace(/^[#＃]+/, "")}`;
}

function applyHashtagFiltersToResult(result, excludedHashtags) {
  if (!result || !Array.isArray(result.posts) || !excludedHashtags?.size) {
    return result;
  }

  const filteredPosts = result.posts.filter((post) => !postMatchesExcludedHashtag(post, excludedHashtags));
  const removedCount = result.posts.length - filteredPosts.length;

  if (!removedCount) {
    return result;
  }

  return {
    ...result,
    posts: filteredPosts,
    warnings: dedupeStrings([
      ...(result.warnings || []),
      `Filtered ${removedCount} post${removedCount === 1 ? "" : "s"} by excluded hashtag rule.`
    ]),
    diagnostics: {
      ...(result.diagnostics || {}),
      hashtagFiltering: {
        excludedCount: removedCount
      }
    }
  };
}

function postMatchesExcludedHashtag(post, excludedHashtags) {
  const hashtags = Array.isArray(post?.hashtags) ? post.hashtags : [];
  return hashtags.some((hashtag) => excludedHashtags.has(String(hashtag || "").toLocaleLowerCase("zh-HK")));
}

function extractFacebookPostsFromPluginHtml(html, options) {
  if (!html) {
    return [];
  }

  const blocks = extractFacebookPostBlocks(html);
  const posts = [];

  for (const block of blocks) {
    const permalink = extractFacebookPermalinkFromBlock(block, options.sourceUrl);

    if (!permalink) {
      continue;
    }

    const structured = extractFacebookStructuredPosting(block, permalink);
    const message = extractFacebookMessage(block);
    const takenAt = extractFacebookTakenAt(block) || normalizeIsoDate(structured?.dateCreated || null);
    const interaction = extractFacebookInteractionCounts(block, structured);
    const imageUrl = structured?.imageUrl || extractFacebookImageUrl(block);
    const identifier = deriveFacebookPostId(permalink, structured?.identifier || null, posts.length + 1);
    const fallbackTitle = cleanText(decodeHtmlEntities(structured?.headline || "")) || `${options.defaultAccountName} 最新貼文`;
    const excerpt = message || fallbackTitle;
    const hashtags = extractHashtagsFromText(excerpt);

    posts.push({
      id: `fb-${identifier}`,
      type: "social",
      platform: "facebook",
      accountName: options.defaultAccountName,
      accountUsername: extractFacebookUsername(options.sourceUrl),
      timeAgo: null,
      takenAt,
      title: truncateText((message || fallbackTitle).split("\n")[0], 80),
      excerpt: truncateText(excerpt, 220),
      hashtags,
      mediaType: "image",
      imageUrl,
      videoThumbnailUrl: null,
      videoUrl: null,
      permalink,
      likeCount: interaction.likes,
      commentCount: interaction.comments,
      shareCount: interaction.shares,
      featured: false,
      tall: false,
      sourcePayload: {
        message: excerpt,
        pluginRendered: Boolean(options.pluginRendered),
        structured: Boolean(structured),
        identifier: structured?.identifier || null
      }
    });
  }

  return dedupePostsByPermalink(posts).slice(0, options.limit);
}

function extractFacebookPostBlocks(html) {
  const marker = /<div[^>]*data-fte="1"[^>]*data-ftr="1"[^>]*>/gi;
  const starts = [];
  let match;

  while ((match = marker.exec(html))) {
    starts.push(match.index);
  }

  if (!starts.length) {
    return [];
  }

  starts.push(html.length);

  return starts.slice(0, -1).map((start, index) => html.slice(start, starts[index + 1]));
}

function extractFacebookPermalinkFromBlock(block, sourceUrl) {
  const linkPattern = /href="([^"]+)"/gi;
  let match;

  while ((match = linkPattern.exec(block))) {
    const href = decodeHtmlEntities(match[1] || "");

    if (href.includes("/sharer/sharer.php")) {
      continue;
    }

    if (!/\/posts\/(?:pfbid[0-9a-z]+|\d+)/i.test(href)) {
      continue;
    }

    const normalized = normalizeFacebookPermalink(href, sourceUrl);

    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeFacebookPermalink(value, sourceUrl) {
  const absolute = normalizeAbsoluteUrl(value, sourceUrl);

  if (!absolute || !/\/posts\/(?:pfbid[0-9a-z]+|\d+)/i.test(absolute)) {
    return null;
  }

  return absolute.split("?")[0];
}

function normalizeAbsoluteUrl(value, sourceUrl) {
  const decoded = decodeHtmlEntities(String(value || "").trim());

  if (!decoded) {
    return null;
  }

  if (decoded.startsWith("//")) {
    return `https:${decoded}`;
  }

  if (decoded.startsWith("/")) {
    return `https://www.facebook.com${decoded}`;
  }

  if (/^https?:\/\//i.test(decoded)) {
    return decoded.replace(/^http:\/\//i, "https://");
  }

  if (!sourceUrl) {
    return null;
  }

  try {
    return new URL(decoded, sourceUrl).toString();
  } catch {
    return null;
  }
}

function extractFacebookTakenAt(block) {
  const match = block.match(/data-utime="(\d{9,})"/i);

  if (!match) {
    return null;
  }

  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function extractFacebookMessage(block) {
  const match = block.match(/data-testid="post_message"[^>]*>([\s\S]*?)<\/div>/i);

  if (!match) {
    return "";
  }

  return htmlFragmentToText(match[1]).replace(/\s*See more$/i, "").trim();
}

function extractFacebookImageUrl(block) {
  const imagePattern = /<img\b([^>]*?)>/gi;
  let match;
  let best = null;

  while ((match = imagePattern.exec(block))) {
    const attrs = parseAttributes(match[1]);
    const rawSrc = attrs.src || attrs["data-src"] || "";
    const src = normalizeAbsoluteUrl(rawSrc, null);

    if (!src || src.startsWith("data:") || src.includes("emoji.php")) {
      continue;
    }

    const width = Number(attrs.width || 0);
    const height = Number(attrs.height || 0);
    let score = width * height;

    if (/scontent\./i.test(src)) {
      score += 1_000_000;
    }

    if (!best || score > best.score) {
      best = { score, src };
    }
  }

  return best?.src || null;
}

function extractFacebookStructuredPosting(html, expectedPermalink) {
  const scriptPattern = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let fallback = null;

  while ((match = scriptPattern.exec(html))) {
    const payload = decodeHtmlEntities(match[1] || "");
    const json = parseJsonSafely(payload);

    if (!json || json["@type"] !== "SocialMediaPosting") {
      continue;
    }

    const permalink = normalizeFacebookPermalink(json.url || "", null);
    const interaction = parseInteractionStatistic(json.interactionStatistic);
    const image = Array.isArray(json.image) ? json.image[0] : json.image;
    const author = json.author || {};
    const candidate = {
      identifier: json.identifier ? String(json.identifier) : null,
      permalink,
      dateCreated: json.dateCreated || null,
      headline: json.headline || "",
      likes: interaction.likes,
      comments: interaction.comments ?? (typeof json.commentCount === "number" ? json.commentCount : null),
      shares: interaction.shares,
      followers: interaction.followers,
      imageUrl: normalizeAbsoluteUrl(image?.contentUrl || image?.url || "", null),
      authorName: cleanText(decodeHtmlEntities(author.name || "")) || null,
      authorImage: normalizeAbsoluteUrl(author.image || "", null)
    };

    if (expectedPermalink && candidate.permalink === expectedPermalink) {
      return candidate;
    }

    if (!fallback) {
      fallback = candidate;
    }
  }

  return fallback;
}

function parseInteractionStatistic(stat) {
  const counters = {
    likes: null,
    comments: null,
    shares: null,
    followers: null
  };
  const items = Array.isArray(stat) ? stat : stat ? [stat] : [];

  for (const item of items) {
    const type = String(item?.interactionType || "");
    const count = Number(item?.userInteractionCount);

    if (!Number.isFinite(count)) {
      continue;
    }

    if (/LikeAction/i.test(type)) {
      counters.likes = count;
    } else if (/CommentAction/i.test(type)) {
      counters.comments = count;
    } else if (/ShareAction/i.test(type)) {
      counters.shares = count;
    } else if (/FollowAction/i.test(type)) {
      counters.followers = count;
    }
  }

  return counters;
}

function extractFacebookInteractionCounts(block, structured) {
  const likeCount = findActionCountFromBlock(block, "Like");
  const commentCount = findActionCountFromBlock(block, "Comment");
  const shareCount = findActionCountFromBlock(block, "Share");

  return {
    likes: likeCount ?? structured?.likes ?? 0,
    comments: commentCount ?? structured?.comments ?? 0,
    shares: shareCount ?? structured?.shares ?? 0
  };
}

function findActionCountFromBlock(block, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<div[^>]*title="${escapedLabel}"[^>]*>([\\s\\S]*?)<\\/div>`, "i");
  const match = block.match(pattern);

  if (!match) {
    return null;
  }

  return parseFirstInteger(htmlFragmentToText(match[1]));
}

function parseFirstInteger(value) {
  const match = String(value || "")
    .replaceAll(",", "")
    .match(/(\d+)/);

  return match ? Number(match[1]) : null;
}

function htmlFragmentToText(html) {
  return cleanText(
    decodeHtmlEntities(
      String(html || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function deriveFacebookPostId(permalink, structuredIdentifier, fallbackIndex) {
  if (structuredIdentifier) {
    return String(structuredIdentifier);
  }

  const pfbidMatch = String(permalink || "").match(/\/posts\/(pfbid[0-9a-z]+)/i);

  if (pfbidMatch) {
    return pfbidMatch[1];
  }

  const numericMatch = String(permalink || "").match(/\/posts\/(\d+)/);

  if (numericMatch) {
    return numericMatch[1];
  }

  return `item-${fallbackIndex}`;
}

function dedupePostsByPermalink(posts) {
  const seen = new Set();
  const output = [];

  for (const post of posts) {
    if (!post.permalink || seen.has(post.permalink)) {
      continue;
    }

    seen.add(post.permalink);
    output.push(post);
  }

  return output;
}

function sortPostsByDate(posts) {
  return [...posts].sort((left, right) => getTimestamp(right.takenAt) - getTimestamp(left.takenAt));
}

function getTimestamp(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.valueOf()) ? 0 : date.getTime();
}

function normalizeIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function parseJsonSafely(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractMetaTags(html) {
  const tags = {};
  const metaPattern = /<meta\s+([^>]+?)\/?>/gi;
  let match;

  while ((match = metaPattern.exec(html))) {
    const attrs = parseAttributes(match[1]);
    const key = attrs.property || attrs.name;

    if (key && attrs.content && !(key in tags)) {
      tags[key] = attrs.content;
    }
  }

  return tags;
}

function parseAttributes(attributeString) {
  const attrs = {};
  const attrPattern = /([a-zA-Z_:.-]+)\s*=\s*"([^"]*)"/g;
  let match;

  while ((match = attrPattern.exec(attributeString))) {
    attrs[match[1].toLowerCase()] = match[2];
  }

  return attrs;
}

function extractFacebookProfileId(html) {
  const profileMatch = String(html || "").match(/fb:\/\/profile\/(\d+)/);

  if (profileMatch) {
    return profileMatch[1];
  }

  const pageIdMatch = String(html || "").match(/"pageID":"(\d+)"/);

  if (pageIdMatch) {
    return pageIdMatch[1];
  }

  const numericUrlMatch = String(html || "").match(/https?:\/\/www\.facebook\.com\/(\d{8,})\?ref=embed_page/);
  return numericUrlMatch ? numericUrlMatch[1] : null;
}

function extractFacebookUsername(value) {
  try {
    const url = new URL(String(value || ""));
    const pathName = url.pathname.replace(/^\/+|\/+$/g, "");

    if (!pathName || pathName.includes("/")) {
      return null;
    }

    if (/^(pages|profile\.php)$/i.test(pathName)) {
      return null;
    }

    return pathName;
  } catch {
    return null;
  }
}

function parseFacebookCounts(description) {
  const matches = [...description.matchAll(/(\d[\d,]*)/g)].map((match) => Number(match[1].replaceAll(",", "")));

  return {
    likes: matches[0] ?? null,
    talkingAbout: matches[1] ?? null,
    checkins: matches[2] ?? null
  };
}

function getFacebookOpenGraphMetadataFromHtml(html, sourceUrl) {
  if (!html) {
    return null;
  }

  const meta = extractMetaTags(html);
  const structured = extractFacebookStructuredPosting(html, normalizeFacebookPermalink(meta["og:url"] || sourceUrl || "", sourceUrl));
  const imageUrl =
    normalizeAbsoluteUrl(decodeHtmlEntities(meta["og:image"] || ""), sourceUrl) ||
    structured?.imageUrl ||
    null;

  return {
    meta,
    imageUrl
  };
}

async function fetchFacebookOpenGraphMetadata(fetchImpl, url) {
  if (!url) {
    return null;
  }

  const html = await fetchTextDocument(fetchImpl, url, {
    headers: {}
  });

  return getFacebookOpenGraphMetadataFromHtml(html, url);
}

function extractFacebookPluginAvatarUrl(html, sourceUrl) {
  if (!html) {
    return null;
  }

  const embedMatch = html.match(
    /href="https:\/\/www\.facebook\.com\/\d+\?ref=embed_page"[^>]*>\s*<img[^>]+src="([^"]+)"/i
  );

  if (embedMatch?.[1]) {
    return normalizeAbsoluteUrl(embedMatch[1], sourceUrl);
  }

  let fallback = null;
  const imagePattern = /<img\b([^>]*?)>/gi;
  let match;

  while ((match = imagePattern.exec(html))) {
    const attrs = parseAttributes(match[1]);
    const src = normalizeAbsoluteUrl(attrs.src || attrs["data-src"] || "", sourceUrl);
    const width = Number(attrs.width || 0);
    const height = Number(attrs.height || 0);

    if (!src || !/scontent\./i.test(src) || !width || !height || width > 200 || height > 200) {
      continue;
    }

    const score = 1_000 - Math.abs(width - height) - Math.abs(width - 50) - Math.abs(height - 50);

    if (!fallback || score > fallback.score) {
      fallback = { score, src };
    }
  }

  return fallback?.src || null;
}

async function fetchJsonDocument(fetchImpl, url, options = {}) {
  const text = await fetchTextDocument(fetchImpl, url, options);
  const json = JSON.parse(text);

  if (options.cachePath) {
    await writeJson(options.cachePath, json);
  }

  return json;
}

async function fetchInstagramReelsFeed(fetchImpl, options) {
  const csrfToken = await fetchInstagramCsrfToken(fetchImpl, options.reelsUrl);
  const body = new URLSearchParams({
    include_feed_video: "true",
    page_size: String(options.pageSize || 12),
    target_user_id: String(options.userId)
  });
  const response = await fetchWithTimeout(fetchImpl, options.reelsApiUrl, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://www.instagram.com",
      referer: options.reelsUrl,
      "x-csrftoken": csrfToken,
      "x-ig-app-id": INSTAGRAM_APP_ID,
      "x-requested-with": "XMLHttpRequest",
      cookie: `csrftoken=${csrfToken}`
    },
    body
  });
  const json = await response.json();

  if (options.cachePath) {
    await writeJson(options.cachePath, json);
  }

  return json;
}

async function fetchInstagramCsrfToken(fetchImpl, pageUrl) {
  const response = await fetchWithTimeout(fetchImpl, pageUrl, {
    headers: DEFAULT_HEADERS
  });
  const setCookieHeaders = getSetCookieHeaders(response.headers);
  const csrfToken = extractCookieValue(setCookieHeaders, "csrftoken");

  await response.arrayBuffer();

  if (!csrfToken) {
    throw new Error(`Instagram reels page did not provide a csrftoken cookie: ${pageUrl}`);
  }

  return csrfToken;
}

async function fetchBinaryDocument(fetchImpl, url, options = {}) {
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: options.headers || DEFAULT_HEADERS
  });
  const buffer = Buffer.from(await response.arrayBuffer());

  if (options.cachePath) {
    await writeBinary(options.cachePath, buffer);
  }

  return buffer;
}

async function cacheRemoteMedia({ remoteUrl, cacheDir, fileName, fetchImpl, referer }) {
  if (!remoteUrl) {
    return { localPath: "", remoteUrl: "" };
  }

  if (!/^https?:\/\//i.test(remoteUrl)) {
    return {
      localPath: remoteUrl,
      remoteUrl
    };
  }

  if (!cacheDir || !fileName || !fetchImpl) {
    return { localPath: "", remoteUrl };
  }

  const cachePath = path.join(cacheDir, fileName);
  const localPath = `.collector-cache/${fileName}`;

  if (await fileExists(cachePath)) {
    return {
      localPath,
      remoteUrl
    };
  }

  try {
    await fetchBinaryDocument(fetchImpl, remoteUrl, {
      cachePath,
      headers: {
        ...DEFAULT_HEADERS,
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        ...(referer ? { referer } : {})
      }
    });

    return {
      localPath,
      remoteUrl
    };
  } catch {
    return { localPath: "", remoteUrl };
  }
}

async function fetchTextDocument(fetchImpl, url, options = {}) {
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: options.headers || DEFAULT_HEADERS
  });
  const text = await response.text();

  if (options.cachePath) {
    await writeText(options.cachePath, text);
  }

  return text;
}

async function fetchJsonIfAvailable(fetchImpl, url) {
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      headers: {
        accept: "application/json",
        "cache-control": "no-store"
      }
    });
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error(`Timed out fetching ${url}`)), FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${url}`);
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getFetchImplementation(customFetch) {
  if (customFetch) {
    return customFetch;
  }

  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available. Use Node 18+ or pass a custom fetch implementation.");
  }

  return fetch.bind(globalThis);
}

function normalizeProductionFeedUrl(value) {
  const input = String(value || "").trim();

  if (!input) {
    return "";
  }

  if (/\/feed\.json(?:\?|#|$)/i.test(input)) {
    return input;
  }

  try {
    return new URL("feed.json", input.endsWith("/") ? input : `${input}/`).toString();
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case "--config":
        args.configPath = next;
        index += 1;
        break;
      case "--output":
        args.outputPath = next;
        index += 1;
        break;
      case "--previous-feed-url":
        args.productionFeedUrl = next;
        index += 1;
        break;
      case "--sample-feed":
        args.sampleFeedPath = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    return null;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getSetCookieHeaders(headers) {
  if (typeof headers?.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const rawHeader = headers?.get ? headers.get("set-cookie") : "";
  return rawHeader ? [rawHeader] : [];
}

function extractCookieValue(setCookieHeaders, name) {
  const pattern = new RegExp(`${name}=([^;]+)`);

  for (const headerValue of setCookieHeaders || []) {
    const match = String(headerValue).match(pattern);

    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

async function writeBinary(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value);
}

function slugifySource(value) {
  return String(value).replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function sanitizeFileToken(value) {
  return String(value || "")
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function truncateText(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function cleanText(value) {
  return String(value || "")
    .replaceAll("\uFFFD", "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  generateFeed
};
