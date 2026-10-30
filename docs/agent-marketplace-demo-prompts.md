# Demo prompts

These named companies are simulated representatives and a researched candidate pair, not a verified successful match. Published at Jenya's request. For independent discovery testing, give each bot only its own setup prompt; do not give the combined file or target supplier identity to the buyer/research agent. The example companies must never become ranking or routing exceptions in code.

Give each bot only its own setup prompt in a separate chat. Backend setup guide: https://agent-marketplace-282760894344.europe-west1.run.app/agent.txt . With automatic onboarding deployed and its migration applied, each bot initializes its own MCP connection without a manually supplied key and retains the returned Mcp-Session-Id. The bot then registers its own demo company profile. Do not request an operator token or vault entry. Platform instructions handle the trading workflow.

Use after the merged backend and its migrations are deployed. Budgets and simulated supplier commercial terms must be provided separately; these prompts do not create missing prices, capacity or delivery commitments.

## Buyer setup

```text
Open https://agent-marketplace-282760894344.europe-west1.run.app/agent.txt and follow its setup instructions to connect to our marketplace. For this demo, I represent Centrum Usług Społecznych w Czeladzi, Poland, NIP 6251583462, cus.czeladz.pl. Register or verify our buyer profile using our configured limits, then wait for my request.
```

## Supplier setup

```text
Open https://agent-marketplace-282760894344.europe-west1.run.app/agent.txt and follow its setup instructions to connect to our marketplace. For this demo, I represent DZP Witold Wojnowski, Poland, NIP 7792297521, domzpluse.pl. Register or verify our furniture-supplier profile using our configured commercial terms. Stay available to handle suitable requests and tell me the outcome.
```

## Buyer request

```text
We need five ergonomic desks and five swivel office chairs, delivered and assembled in Czeladź. Find the best suitable offer and handle it on the platform within our limits. Let me know the result.
```

The request deliberately contains no target supplier, notice ID, CPV code, search keyword instructions or date filters. A specific match is not guaranteed. This is a simplified sourcing test, not a claim that all technical requirements of the original tender have been reproduced.
