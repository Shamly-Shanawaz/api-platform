# Run Contract Clause Checker inside your network

Documents never leave your network when you run your own copy.

## Requirements

- Docker.
- An API key for your model provider.

## Run

```bash
docker run --rm -p 8080:8080 -e MODEL_API_KEY ghcr.io/example/contract-clause-checker:0.9.0
```

The agent then serves A2A at `http://localhost:8080`.

## Environment variables

| Name | Required | Description |
|---|---|---|
| `MODEL_API_KEY` | Yes (secret) | Key for your model provider. |
