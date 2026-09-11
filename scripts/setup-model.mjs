import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const modelDirectory = fileURLToPath(new URL('../models/', import.meta.url));
const checkOnly = process.argv.includes('--check');

async function verifyModel(path, model) {
  let details;
  try {
    details = await stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return '모델 파일이 없습니다.';
    throw error;
  }
  if (!details.isFile() || details.size !== model.bytes) {
    return `모델 크기가 다릅니다. 예상: ${model.bytes} bytes, 실제: ${details.size} bytes`;
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== model.sha256) return '모델의 SHA-256 검증에 실패했습니다.';
  return null;
}

async function main() {
  if (process.argv.slice(2).some((argument) => argument !== '--check')) {
    throw new Error('사용법: node scripts/setup-model.mjs [--check]');
  }
  const model = JSON.parse(await readFile(join(modelDirectory, 'model.json'), 'utf8'));
  const target = join(modelDirectory, model.filename);
  const problem = await verifyModel(target, model);
  if (!problem) {
    console.log(`모델 준비 완료 (SHA-256 확인): ${target}`);
    return;
  }
  if (checkOnly) {
    throw new Error(`${problem}\n빌드 전에 node scripts/setup-model.mjs 명령으로 모델을 준비하세요.`);
  }

  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.part`;
  console.log(`${problem}\n${model.filename} 다운로드 (${(model.bytes / 1e9).toFixed(2)} GB). 최초 개발/빌드 준비에만 인터넷을 사용합니다.`);
  let received = 0;
  let lastUpdate = 0;
  try {
    const response = await fetch(model.url, {
      signal: AbortSignal.timeout(60 * 60 * 1000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`다운로드 서버 응답: HTTP ${response.status} ${response.statusText}`);
    }
    const progress = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > model.bytes) {
          callback(new Error('다운로드 크기가 예상한 모델 크기를 초과했습니다.'));
          return;
        }
        if (Date.now() - lastUpdate >= 2000 || received === model.bytes) {
          console.log(`모델 다운로드: ${(received / model.bytes * 100).toFixed(1)}% (${Math.round(received / 1e6)} / ${Math.round(model.bytes / 1e6)} MB)`);
          lastUpdate = Date.now();
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial));
    console.log('다운로드 완료. 파일 크기와 SHA-256을 확인합니다.');
    const verificationProblem = await verifyModel(partial, model);
    if (verificationProblem) throw new Error(verificationProblem);
    await rename(partial, target);
    console.log(`모델 준비 완료: ${target}\n이후 실행에는 모델 다운로드나 외부 API가 필요하지 않습니다.`);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw new Error(`모델을 준비하지 못했습니다: ${error.message}\n인터넷 연결 및 여유 공간(최소 ${(model.bytes / 1e9).toFixed(2)} GB)을 확인한 뒤 node scripts/setup-model.mjs 명령을 다시 실행하세요.`, { cause: error });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
