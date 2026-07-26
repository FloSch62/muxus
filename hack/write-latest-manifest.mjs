import fs from 'node:fs';
import path from 'node:path';

const [sourcePath = '', outPath = 'site/latest.json'] = process.argv.slice(2);

function readJson(file) {
  if (!file) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeVersion(tag) {
  return tag.trim().replace(/^v/i, '');
}

const source = readJson(sourcePath) ?? {};
const tag = firstString(process.env.RELEASE_TAG, source.tagName, source.tag_name, source.tag);
const releaseName = firstString(process.env.RELEASE_NAME, source.name, tag);
const releaseUrl = firstString(process.env.RELEASE_URL, source.url, source.html_url);
const publishedAt = firstString(process.env.RELEASE_PUBLISHED_AT, source.publishedAt, source.published_at);

if (!tag) fail('Release metadata must include tagName, tag_name, tag, or RELEASE_TAG.');
if (!releaseUrl) fail('Release metadata must include url, html_url, or RELEASE_URL.');
if (!publishedAt) fail('Release metadata must include publishedAt, published_at, or RELEASE_PUBLISHED_AT.');

const version = normalizeVersion(tag);
if (!version) fail('Release metadata resolved to an empty version.');

const manifest = {
  version,
  releaseName,
  releaseUrl,
  publishedAt,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath} for ${manifest.version}`);
