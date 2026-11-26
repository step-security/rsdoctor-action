[![StepSecurity Maintained Action](https://raw.githubusercontent.com/step-security/maintained-actions-assets/main/assets/maintained-action-banner.png)](https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions)

# Rsdoctor Bundle Analysis Action

Report Rsdoctor bundle metrics on pull requests and workflow summaries, with optional AI-assisted analysis. Tracks JavaScript, CSS, HTML, and other asset sizes; compares against the baseline from the target branch; and generates interactive HTML diff reports.

## Usage

### Minimal setup

```yaml
- name: Bundle Analysis
  uses: step-security/rsdoctor-action@main
  with:
    file_path: 'dist/rsdoctor-data.json'
```

### Full workflow example

```yaml
name: Bundle Analysis

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches:
      - main
  workflow_dispatch:

jobs:
  bundle-analysis:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: actions/checkout@v7

      - name: Install and build
        run: npm ci && npm run build

      - name: Bundle Analysis
        uses: step-security/rsdoctor-action@v1
        env:
          AI_TOKEN: ${{ secrets.AI_TOKEN }}
        with:
          file_path: 'dist/rsdoctor-data.json'
          target_branch: 'main'
          ai_model: 'claude-3-5-haiku-latest'
```

## Inputs

| Input                    | Description                                                                                                           | Required | Default                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------- |
| `file_path`              | Glob pattern or path to the Rsdoctor JSON data file emitted by the build                                              | Yes      | —                         |
| `target_branch`          | Branch to compare against for baseline metrics. Defaults to the repository default branch                             | No       | repo default              |
| `dispatch_target_branch` | Override the comparison branch when triggered by `workflow_dispatch`                                                  | No       | `''`                      |
| `enable_ai_analysis`     | Set to `false` to disable AI-assisted bundle degradation analysis                                                     | No       | `true`                    |
| `ai_model`               | LLM model for degradation analysis. Provider is auto-detected from the model name prefix. Requires `AI_TOKEN` env var | No       | `claude-3-5-haiku-latest` |
| `github_token`           | GitHub token for posting PR comments and accessing repository data                                                    | No       | `github.token`            |

### Dynamic target branch

To compare against the PR base branch rather than a fixed branch name:

```yaml
target_branch: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.ref || github.event.repository.default_branch }}
```

## How it works

The action behaves differently depending on the trigger event:

- **`push`** — uploads the current bundle artifact as a baseline for future comparisons. No diff is produced.
- **`pull_request`** — downloads the baseline artifact from the target branch, computes a size diff, and posts or updates a comment on the PR.
- **`workflow_dispatch`** — uploads an artifact and produces a diff report in the workflow summary. Use `dispatch_target_branch` to control which branch is used as the baseline.

## Plugin setup

Install the Rsdoctor plugin for your build tool, enable Brief mode, and emit JSON output:

```typescript
// rsbuild.config.ts
import { RsdoctorRspackPlugin } from '@rsdoctor/core';

export default defineConfig({
  tools: {
    rspack: {
      plugins: [
        new RsdoctorRspackPlugin({
          disableClientServer: true,
          output: {
            mode: 'brief',
            options: { type: ['json'] },
          },
        }),
      ],
    },
  },
});
```

Requires `@rsdoctor/core@2` with Rspack 2 or a compatible Rsbuild version.

Supported build tools:

| Tool             | Plugin / Package   |
| ---------------- | ------------------ |
| Rsbuild / Rspack | `@rsdoctor/core@2` |

> **Note:** Rsdoctor 2 does not support webpack. For webpack projects, continue using Rsdoctor 1.x.

## Troubleshooting

**Rsdoctor data file not found** — confirm the build step runs before this action and that `file_path` matches the location where the plugin writes `rsdoctor-data.json`.

**No baseline found on first run** — expected behavior. The action uploads the current run as the baseline; comparisons will appear on subsequent pull requests.

**AI analysis not running** — set `AI_TOKEN` as a repository secret and pass it via `env`. The provider is inferred automatically from the model name (e.g. `claude-*` → Anthropic, `gpt-*` → OpenAI, `gemini-*` → Google).

## License

MIT — see [LICENSE](LICENSE) for details.
