import {
  describe,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  it,
  expect,
} from 'rstack/test';
import { ActionsClient } from '../src/octokit-client';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

const API = 'https://api.github.com';
const REPO_BASE = '/repos/step-security/rsdoctor-action';

function matchQuery(basePath: string, params: Record<string, string | number>) {
  return (p: string) => {
    const [path, qs] = p.split('?');
    if (path !== basePath) return false;
    const sp = new URLSearchParams(qs ?? '');
    return Object.entries(params).every(([k, v]) => sp.get(k) === String(v));
  };
}

function jsonReply(
  pool: ReturnType<MockAgent['get']>,
  method: string,
  path: string | ((p: string) => boolean),
  body: unknown,
  status = 200,
) {
  pool.intercept({ method, path }).reply(status, JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('ActionsClient', () => {
  let client: ActionsClient;
  let agent: MockAgent;
  let pool: ReturnType<MockAgent['get']>;
  let originalDispatcher: Dispatcher;

  beforeAll(() => {
    originalDispatcher = getGlobalDispatcher();
  });

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    pool = agent.get(API);
    client = new ActionsClient('test-token');
  });

  afterEach(async () => {
    await agent.close();
  });

  afterAll(() => {
    setGlobalDispatcher(originalDispatcher);
  });

  describe('getCurrentCommitHash', () => {
    it('should return current commit hash', () => {
      const hash = client.getCurrentCommitHash();
      expect(hash).toMatch(/^[a-f0-9]{10}$/);
    });
  });

  describe('resolveTargetBranch', () => {
    it('should return the configured target branch', async () => {
      const branch = await client.resolveTargetBranch('', 'main');
      expect(branch).toBe('main');
    });

    it('should use the repository default branch when not configured', async () => {
      jsonReply(pool, 'GET', REPO_BASE, { default_branch: 'master' });

      const branch = await client.resolveTargetBranch('', '');
      expect(branch).toBe('master');
    });

    it('should fall back to main when the repository query fails', async () => {
      jsonReply(
        pool,
        'GET',
        REPO_BASE,
        { message: 'Resource not accessible by integration' },
        403,
      );

      const branch = await client.resolveTargetBranch('', '');
      expect(branch).toBe('main');
    });
  });

  describe('resolveBaselineCommit', () => {
    it('should get commit from GitHub API', async () => {
      const mockCommitSha = 'abcdef1234abcdef1234abcdef1234abcdef1234';

      jsonReply(pool, 'GET', `${REPO_BASE}/branches/main`, {
        commit: { sha: mockCommitSha },
      });
      jsonReply(
        pool,
        'GET',
        matchQuery(`${REPO_BASE}/actions/runs`, {
          branch: 'main',
          head_sha: mockCommitSha,
          status: 'completed',
          per_page: 30,
        }),
        { workflow_runs: [] },
      );
      jsonReply(
        pool,
        'GET',
        matchQuery(`${REPO_BASE}/actions/runs`, {
          branch: 'main',
          status: 'completed',
          per_page: 100,
        }),
        { workflow_runs: [] },
      );
      jsonReply(pool, 'GET', `${REPO_BASE}/commits/${mockCommitSha}`, {
        sha: mockCommitSha,
        parents: [],
      });

      const result = await client.resolveBaselineCommit('', 'main');
      expect(result).toHaveProperty('commitHash');
      expect(result).toHaveProperty('usedFallback');
      expect(result.commitHash).toBe(mockCommitSha);
      expect(result.usedFallback).toBe(false);
    });

    it('should return fallback info when latest commit has no artifacts', async () => {
      const mockCommitSha = 'abcdef1234abcdef1234abcdef1234abcdef1234';
      const mockParentSha = '1234567890abcdef1234567890abcdef12345678';

      jsonReply(pool, 'GET', `${REPO_BASE}/branches/main`, {
        commit: { sha: mockCommitSha },
      });
      jsonReply(
        pool,
        'GET',
        matchQuery(`${REPO_BASE}/actions/runs`, {
          branch: 'main',
          head_sha: mockCommitSha,
          status: 'completed',
          per_page: 30,
        }),
        { workflow_runs: [] },
      );
      jsonReply(
        pool,
        'GET',
        matchQuery(`${REPO_BASE}/actions/runs`, {
          branch: 'main',
          status: 'completed',
          per_page: 100,
        }),
        { workflow_runs: [] },
      );
      jsonReply(pool, 'GET', `${REPO_BASE}/commits/${mockCommitSha}`, {
        sha: mockCommitSha,
        parents: [{ sha: mockParentSha }],
      });
      jsonReply(
        pool,
        'GET',
        matchQuery(`${REPO_BASE}/actions/runs`, {
          branch: 'main',
          head_sha: mockParentSha,
          status: 'completed',
          per_page: 30,
        }),
        {
          workflow_runs: [
            {
              id: 123,
              name: 'CI',
              head_sha: mockParentSha,
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      );
      jsonReply(pool, 'GET', `${REPO_BASE}/actions/runs/123/artifacts`, {
        artifacts: [{ id: 1, name: 'test-artifact' }],
      });

      const result = await client.resolveBaselineCommit('', 'main');
      expect(result).toHaveProperty('commitHash');
      expect(result).toHaveProperty('usedFallback');
      expect(result).toHaveProperty('latestCommit');
      expect(result.commitHash).toBe(mockParentSha);
      expect(result.usedFallback).toBe(true);
      expect(result.latestCommit).toBe(mockCommitSha);
    });

    it('should fail when the target branch cannot be queried', async () => {
      jsonReply(
        pool,
        'GET',
        `${REPO_BASE}/branches/main`,
        { message: 'Branch not found' },
        404,
      );

      await expect(client.resolveBaselineCommit('', 'main')).rejects.toThrow(
        'Failed to get target branch (main) commit: Branch not found',
      );
    });

    it('should use the full SHA when querying workflow runs for baseline artifacts', async () => {
      const mockCommitSha = 'fedcba9876fedcba9876fedcba9876fedcba9876';

      jsonReply(pool, 'GET', `${REPO_BASE}/branches/main`, {
        commit: { sha: mockCommitSha },
      });
      jsonReply(
        pool,
        'GET',
        matchQuery(`${REPO_BASE}/actions/runs`, {
          branch: 'main',
          head_sha: mockCommitSha,
          status: 'completed',
          per_page: 30,
        }),
        {
          workflow_runs: [
            {
              id: 456,
              name: 'CI',
              head_sha: mockCommitSha,
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      );
      jsonReply(pool, 'GET', `${REPO_BASE}/actions/runs/456/artifacts`, {
        artifacts: [{ id: 1, name: 'rsdoctor-artifact' }],
      });

      const result = await client.resolveBaselineCommit('', 'main');
      expect(result.commitHash).toBe(mockCommitSha);
      expect(result.usedFallback).toBe(false);
    });
  });

  describe('findRunForCommit', () => {
    it('should filter the exact workflow run lookup by branch', async () => {
      const fullSha = 'abcdef1234abcdef1234abcdef1234abcdef1234';

      jsonReply(
        pool,
        'GET',
        matchQuery(`${REPO_BASE}/actions/runs`, {
          branch: 'main',
          head_sha: fullSha,
          status: 'completed',
          per_page: 10,
        }),
        {
          workflow_runs: [
            { id: 456, head_sha: fullSha, conclusion: 'success' },
          ],
        },
      );

      const run = await client.findRunForCommit(fullSha, 'completed', 'main');
      expect(run.id).toBe(456);
    });
  });

  describe('findAllRunsForCommit', () => {
    it('should filter fallback workflow run lookup by branch', async () => {
      const fullSha = 'abcdef1234abcdef1234abcdef1234abcdef1234';

      jsonReply(
        pool,
        'GET',
        matchQuery(`${REPO_BASE}/actions/runs`, {
          branch: 'main',
          head_sha: fullSha,
          status: 'completed',
          per_page: 30,
        }),
        { workflow_runs: [] },
      );
      jsonReply(
        pool,
        'GET',
        matchQuery(`${REPO_BASE}/actions/runs`, {
          branch: 'main',
          status: 'completed',
          per_page: 100,
        }),
        {
          workflow_runs: [
            { id: 789, head_sha: fullSha, conclusion: 'success' },
          ],
        },
      );

      const runs = await client.findAllRunsForCommit(
        fullSha,
        'completed',
        'main',
      );
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe(789);
    });
  });
});
