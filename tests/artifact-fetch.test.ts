import * as path from 'path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
} from 'rstack/test';
import {
  resolveAndFetchBaseline,
  extractZipEntry,
} from '../src/artifact-fetch';
import { buildArtifactKey, fingerprintPath } from '../src/artifact-store';
import { silenceConsole, restoreConsole } from './helpers/console-spy';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

const API = 'https://api.github.com';
const REPO_BASE = '/repos/step-security/rsdoctor-action';

const artifactZip = Buffer.from(
  'UEsDBBQAAAAIAMV58FyYwF+WKQAAADEAAAAZAAAAbmVzdGVkL3JzZG9jdG9yLWRhdGEuanNvbqtWSkksSVSyqlZKzijNy3YvSizIAPESi4tTS4qVrKJjdSAyYHZtbS0AUEsBAhQDFAAAAAgAxXnwXJjAX5YpAAAAMQAAABkAAAAAAAAAAAAAAIABAAAAAG5lc3RlZC9yc2RvY3Rvci1kYXRhLmpzb25QSwUGAAAAAAEAAQBHAAAAYAAAAAAA',
  'base64',
);

function matchQuery(basePath: string, params: Record<string, string | number>) {
  return (p: string) => {
    const [path, qs] = p.split('?');
    if (path !== basePath) return false;
    const sp = new URLSearchParams(qs ?? '');
    return Object.entries(params).every(([k, v]) => sp.get(k) === String(v));
  };
}

describe('ArtifactFetch', () => {
  const commitHash = 'abc1234567abc1234567abc1234567abc1234567';
  const shortCommitHash = commitHash.substring(0, 10);
  const filePath = '/tmp/test/rsdoctor-data.json';
  const fileName = 'rsdoctor-data.json';
  const workflowRunId = 123;

  let agent: MockAgent;
  let pool: ReturnType<MockAgent['get']>;
  let originalDispatcher: Dispatcher;

  beforeAll(() => {
    originalDispatcher = getGlobalDispatcher();
  });

  beforeEach(() => {
    silenceConsole();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    pool = agent.get(API);
  });

  afterEach(async () => {
    restoreConsole();
    await agent.close();
  });

  afterAll(() => {
    setGlobalDispatcher(originalDispatcher);
  });

  function getPathHash() {
    const relativePath = path.relative(process.cwd(), filePath);
    const pathParts = relativePath.split(path.sep);
    return fingerprintPath(pathParts, 'rsdoctor-data');
  }

  function mockArtifactSearch(artifactName: string, artifactId: number) {
    pool
      .intercept({
        method: 'GET',
        path: matchQuery(`${REPO_BASE}/actions/runs`, {
          head_sha: commitHash,
          status: 'completed',
          per_page: 30,
        }),
      })
      .reply(
        200,
        JSON.stringify({
          workflow_runs: [
            {
              id: workflowRunId,
              name: 'CI',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    pool
      .intercept({
        method: 'GET',
        path: `${REPO_BASE}/actions/runs/${workflowRunId}/artifacts`,
      })
      .reply(
        200,
        JSON.stringify({
          artifacts: [
            {
              id: artifactId,
              name: artifactName,
              created_at: '2026-05-08T00:00:00Z',
              size_in_bytes: 100,
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    pool
      .intercept({
        method: 'GET',
        path: `${REPO_BASE}/actions/artifacts/${artifactId}/zip`,
      })
      .reply(200, Buffer.from('not a zip'), {
        headers: { 'content-type': 'application/zip' },
      });
  }

  it('should read the target JSON directly from a nested ZIP entry', async () => {
    const content = await extractZipEntry(artifactZip, fileName);

    expect(JSON.parse(content.toString('utf-8'))).toEqual({
      data: {
        chunkGraph: {
          assets: [],
          chunks: [],
        },
      },
    });
  });

  it('should reject when the target entry does not exist', async () => {
    await expect(extractZipEntry(artifactZip, 'missing.json')).rejects.toThrow(
      'Entry missing.json not found in zip',
    );
  });

  it('should reject instead of exiting silently when ZIP opening stalls', async () => {
    await expect(
      extractZipEntry(Buffer.alloc(0), fileName, 10, () => undefined),
    ).rejects.toThrow(`Zip extraction timed out after 10ms for ${fileName}`);
  });

  it('should find artifacts that use the rsdoctor-prefixed name', async () => {
    const pathHash = getPathHash();
    const artifactName = buildArtifactKey(pathHash, shortCommitHash);
    mockArtifactSearch(artifactName, 101);

    await expect(
      resolveAndFetchBaseline(commitHash, fileName, filePath),
    ).rejects.toThrow();
  });

  it('should find artifacts that use the legacy unprefixed name', async () => {
    const pathHash = getPathHash();
    mockArtifactSearch(`${pathHash}-${shortCommitHash}`, 202);

    await expect(
      resolveAndFetchBaseline(commitHash, fileName, filePath),
    ).rejects.toThrow();
  });

  it('should find artifacts that use the legacy unprefixed name with extension', async () => {
    const pathHash = getPathHash();
    mockArtifactSearch(`${pathHash}-${shortCommitHash}.json`, 303);

    await expect(
      resolveAndFetchBaseline(commitHash, fileName, filePath),
    ).rejects.toThrow();
  });

  it('should also find artifacts that use a full SHA name', async () => {
    const pathHash = getPathHash();
    const artifactName = buildArtifactKey(pathHash, commitHash);
    mockArtifactSearch(artifactName, 404);

    await expect(
      resolveAndFetchBaseline(commitHash, fileName, filePath),
    ).rejects.toThrow();
  });
});
