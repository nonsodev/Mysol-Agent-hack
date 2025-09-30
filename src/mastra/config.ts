// Google config
import dotenv from "dotenv";
import { google } from "@ai-sdk/google";

dotenv.config();

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!apiKey) {
  throw new Error("Missing GOOGLE_GENERATIVE_AI_API_KEY");
}

export const modelName = "gemini-2.0-flash";

// Create a standalone Gemini model instance
export const model = google(modelName, { apiKey, simulateStreaming: true });

console.log(`Model configured: ${modelName}`);
