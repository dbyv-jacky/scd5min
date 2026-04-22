const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { generateFeed } = require("../content-collector.js");

const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const ASSET_FILES = ["app.js", "styles.css"];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(DIST_DIR, { recursive: true });

  const assetManifest = await buildHashedAssets();
  const feed = await buildFeed();
  const config = await readJson(path.join(ROOT_DIR, "board.config.json"));
  const { buildRuntimeBoardData } = await loadPortableCore();
  const boardData = buildRuntimeBoardData(feed || {}, config || {});

  await Promise.all([
    buildHtmlFile("index.html", assetManifest, boardData),
    buildHtmlFile("embed.html", assetManifest, boardData),
    fs.writeFile(path.join(ROOT_DIR, "board.data.json"), `${JSON.stringify(boardData, null, 2)}\n`, "utf8"),
    fs.writeFile(path.join(DIST_DIR, "board.data.json"), `${JSON.stringify(boardData, null, 2)}\n`, "utf8"),
    copyStaticFile("feed.json")
  ]);

  await copyPublishedCacheFiles(".collector-cache");
}

async function buildHashedAssets() {
  const manifest = {};

  for (const fileName of ASSET_FILES) {
    const sourcePath = path.join(ROOT_DIR, fileName);
    const content = await fs.readFile(sourcePath);
    const hash = crypto.createHash("sha1").update(content).digest("hex").slice(0, 10);
    const extension = path.extname(fileName);
    const baseName = path.basename(fileName, extension);
    const outputName = `${baseName}.${hash}${extension}`;

    await fs.writeFile(path.join(DIST_DIR, outputName), content);
    manifest[fileName] = outputName;
  }

  return manifest;
}

async function buildHtmlFile(fileName, assetManifest, boardData) {
  const sourcePath = path.join(ROOT_DIR, fileName);
  let html = await fs.readFile(sourcePath, "utf8");

  html = html.replaceAll('href="./styles.css"', `href="./${assetManifest["styles.css"]}"`);
  html = html.replaceAll('src="./app.js"', `src="./${assetManifest["app.js"]}"`);
  html = html.replace(
    /<script id="board-bootstrap" type="application\/json">[\s\S]*?<\/script>/,
    `<script id="board-bootstrap" type="application/json">${serializeInlineJson(boardData)}</script>`
  );

  await fs.writeFile(path.join(DIST_DIR, fileName), html, "utf8");
}

async function buildFeed() {
  const productionFeedUrl =
    process.env.PRODUCTION_FEED_URL ||
    (process.env.PRODUCTION_SITE_URL ? new URL("feed.json", ensureTrailingSlash(process.env.PRODUCTION_SITE_URL)).toString() : "");

  const outputPath = path.join(ROOT_DIR, "feed.json");

  await generateFeed({
    configPath: path.join(ROOT_DIR, "collector.config.json"),
    outputPath,
    productionFeedUrl,
    sampleFeedPath: path.join(ROOT_DIR, "collected-feed.test.json")
  });

  return readJson(outputPath);
}

async function copyStaticFile(fileName) {
  const sourcePath = path.join(ROOT_DIR, fileName);
  const destinationPath = path.join(DIST_DIR, fileName);
  const content = await fs.readFile(sourcePath);
  await fs.writeFile(destinationPath, content);
}

async function copyPublishedCacheFiles(directoryName) {
  const sourcePath = path.join(ROOT_DIR, directoryName);
  const destinationPath = path.join(DIST_DIR, directoryName);

  try {
    await fs.access(sourcePath);
    await fs.cp(sourcePath, destinationPath, {
      recursive: true,
      force: true
    });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
}

async function loadPortableCore() {
  const portableCorePath = pathToFileURL(path.join(ROOT_DIR, "scripts/lib/portable-core.mjs")).href;
  return import(portableCorePath);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function serializeInlineJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
