import { generateText } from "ai";
import { model } from "../../../config"; // Fixed import path

export async function callLLM(prompt: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: model,
      prompt: prompt,
      system: "You are a Solana token expert. Write concise, friendly, and accurate token descriptions.",
      maxTokens: 120,
      temperature: 0.7,
    });
    return text.trim() || "";
  } catch (error) {
    console.error("Error calling LLM:", error);
    return "Unable to generate description at this time.";
  }
}