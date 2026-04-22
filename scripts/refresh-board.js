const path = require("node:path");
const { generateFeed } = require("../content-collector.js");

const ROOT_DIR = path.resolve(__dirname, "..");

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const productionFeedUrl =
    process.env.PRODUCTION_FEED_URL ||
    (process.env.PRODUCTION_SITE_URL ? new URL("feed.json", ensureTrailingSlash(process.env.PRODUCTION_SITE_URL)).toString() : "");

  const payload = await generateFeed({
    configPath: path.join(ROOT_DIR, "collector.config.json"),
    outputPath: path.join(ROOT_DIR, "feed.json"),
    sampleFeedPath: path.join(ROOT_DIR, "collected-feed.test.json"),
    productionFeedUrl
  });

  console.log(
    JSON.stringify(
      {
        collectedAt: payload.collectedAt,
        postsCollected: payload.summary?.postsCollected || 0,
        sourcesCollected: payload.summary?.sourcesCollected || 0
      },
      null,
      2
    )
  );
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}
