# Backend Architecture

This backend folder contains the Telegram bot and API infrastructure that integrates with the existing Mastra workflows.

## Structure

```
backend/
├── api/           # REST API endpoints
├── bot/           # Telegram bot implementation
├── services/      # Business logic services
├── database/      # Database schemas and migrations
├── utils/         # Utility functions
├── types/         # TypeScript type definitions
├── middleware/    # Express/Bot middleware
└── index.ts       # Main backend entry point
```

## Integration with Mastra

The backend acts as an interface layer that:
- Receives Telegram commands and API requests
- Translates them into Mastra workflow executions
- Manages user wallets and sessions
- Returns formatted responses

## Key Components

1. **Telegram Bot** (`bot/`) - Handles user interactions
2. **Wallet Service** (`services/wallet.ts`) - Manages Solana wallets
3. **User Service** (`services/user.ts`) - User management
4. **API Routes** (`api/`) - REST endpoints for web interface
5. **Database Layer** (`database/`) - Schema and migrations
