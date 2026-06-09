import { createRequire } from 'module';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findOptionalPackageDir(packageName) {
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'node_modules', packageName);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

const tiktokenPackageDir = findOptionalPackageDir('tiktoken');
const tiktoken = tiktokenPackageDir ? require(tiktokenPackageDir) : null;

let cachedEncoder;
let cachedModel;

function getEncoder(model = 'gpt-4o-mini') {
  if (!tiktoken) return null;
  if (cachedEncoder && cachedModel === model) return cachedEncoder;
  if (cachedEncoder) cachedEncoder.free?.();

  cachedEncoder = tiktoken.get_encoding('cl100k_base');
  cachedModel = model;
  return cachedEncoder;
}

export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function messagesToText(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((message) => contentToText(message?.content))
    .filter(Boolean)
    .join('\n');
}

export function countTextTokens(text, model) {
  if (!text) return 0;
  const encoder = getEncoder(model);
  if (!encoder) return Math.ceil(text.length / 4);
  return encoder.encode(text).length;
}

export function countTokens(messages, model) {
  return countTextTokens(messagesToText(messages), model);
}

export function truncateTextToTokens(text, maxTokens, model) {
  if (!text || maxTokens <= 0) return '';
  const encoder = getEncoder(model);
  if (!encoder) return text.slice(0, maxTokens * 4);
  const tokens = encoder.encode(text);
  if (tokens.length <= maxTokens) return text;
  return encoder.decode(tokens.slice(0, maxTokens));
}
