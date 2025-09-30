import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";
import { solanaAgent } from "./agents/solana-agent/solana-agent"; // Updated import for your renamed agent
import { 
  solanaPortfolioAnalysis,
  tokenResearch,
  tokenLaunchWorkflow,
  tradingWorkflow
} from "./workflows";

export const mastra = new Mastra({
  workflows: { 
    solanaPortfolioAnalysis,
    tokenResearch,
    tokenLaunchWorkflow,
    tradingWorkflow
  },
  agents: { solanaAgent }, // Only include existing agents
  storage: new LibSQLStore({
    url: "file:./mastra.db", // Persistent storage for workflow data
  }),
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
  server: {
    port: 8080,
    timeout: 10000,
  },
});