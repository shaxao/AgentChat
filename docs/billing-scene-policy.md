# Scene Billing Policy

AutoCode and chat now share one billing engine. Upstream channel billing mode is separate from user-side quota and wallet charging.

## Configure by `features` JSON

Put this JSON in `subscription_plan.features` or `subscription.features`.

```json
{
  "billing": {
    "scenes": {
      "chat": {
        "enabled": true,
        "costLimit": 100,
        "walletFallbackEnabled": false,
        "walletFallbackMonthlyLimit": 0,
        "upstreamBillingMode": "metered"
      },
      "autocode": {
        "enabled": true,
        "costLimit": 200,
        "walletFallbackEnabled": false,
        "walletFallbackMonthlyLimit": 0,
        "upstreamBillingMode": "coding_plan"
      },
      "workflow": {
        "enabled": true,
        "costLimit": 50,
        "walletFallbackEnabled": false,
        "walletFallbackMonthlyLimit": 0,
        "upstreamBillingMode": "metered"
      }
    }
  }
}
```

## Safety defaults

- Wallet fallback is disabled by default.
- Coding Plan only describes upstream cost mode. It does not make user usage free automatically.
- If scene quota is exhausted and wallet fallback is disabled, the request is rejected before model execution when possible.
- If wallet fallback is enabled, only the overflow part is charged to wallet.
- Wallet deduction still uses `WalletService.consume`, which performs atomic balance checks.

## Current behavior

- Chat preflight uses `scene=chat`.
- Agent/code development requests use `scene=autocode`.
- `/api/admin/internal/usage` defaults to `scene=autocode` and returns HTTP-style code `402` when billing fails.
- Legacy `costLimit/costUsed` remains the fallback when no scene policy is configured.
