# Run Accounts Payable Assistant yourself

Runs inside your own network; invoices never leave it.

## Requirements

- Docker.
- Network access to your ERP's API.

## Run

```bash
docker run --rm -p 8080:8080 \
  -e MODEL_API_KEY -e ERP_URL=https://erp.internal.example.com \
  ghcr.io/acme-finance/ap-assistant:2.0.0
```

## Environment variables

| Name | Required | Description |
|---|---|---|
| `MODEL_API_KEY` | Yes (secret) | Key for your model provider. |
| `ERP_URL` | Yes | Your ERP's API address. |
