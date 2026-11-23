# Run Repo Docs Writer yourself

## Requirements

- Node.js 20 or later, or Docker.
- An API key for an OpenAI-compatible model provider.

## Run with npx

The quickest way to try it in an existing repository:

```bash
export LLM_API_KEY=<your-key>
npx @acme/repo-docs-writer@2.3.0 run
```

## Run with Docker

The repository is mounted read-write at `/workspace`:

```bash
docker pull ghcr.io/acme/repo-docs-writer:2.3.0
docker run --rm -v "$PWD:/workspace" -e LLM_API_KEY ghcr.io/acme/repo-docs-writer:2.3.0 run
```

## Run in GitHub Actions

Add this step to a workflow to check for docs drift on every pull request:

```yaml
- uses: acme/repo-docs-writer-action@v2
  with:
    mode: drift-check
  env:
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
```

## Environment variables

| Name | Required | Description |
|---|---|---|
| `LLM_API_KEY` | Yes (secret) | API key for the model provider the agent calls. |
| `GITHUB_TOKEN` | No (secret) | Needed only to open a pull request with the generated docs. |
| `DOCS_OUTPUT_DIR` | No | Where generated files are written, relative to the repository root. Default `docs/`. |
