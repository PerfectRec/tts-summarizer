import { FastifyRequest, FastifyReply } from "fastify";
import { LlamaParseReader } from "llamaindex";
import Anthropic from "@anthropic-ai/sdk";
import FirecrawlApp from "@mendable/firecrawl-js";
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import os from "os";

interface SummarizeRequestParams {
  summarizationMethod:
    | "betterAbstract"
    | "twoPage"
    | "chaptered"
    | "tablesAndFiguresOnly"
    | "ultimate";
}

type Model = "claude-3-5-sonnet-20240620";

const ANTHROPIC_TEMPERATURE = 0;
const ANTHROPIC_MODEL = "claude-3-5-sonnet-20240620";

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    "anthropic-beta":
      "prompt-caching-2024-07-31,max-tokens-3-5-sonnet-2024-07-15",
  },
});

export default async function handler(
  request: FastifyRequest<{
    Querystring: SummarizeRequestParams;
  }>,
  reply: FastifyReply
) {
  const { summarizationMethod } = request.query;
  const fileBuffer = request.body;

  // Create a temporary file path
  const tempFilePath = path.join(os.tmpdir(), "tempfile");

  // Write the buffer to the temporary file
  if (typeof fileBuffer === "string" || fileBuffer instanceof Buffer) {
    fs.writeFileSync(tempFilePath, fileBuffer);
  } else {
    throw new Error("Invalid file buffer type");
  }

  const tempImageDir = fs.mkdtempSync(path.join(os.tmpdir(), "images-"));

  // Instantiate LlamaParseReader
  const reader = new LlamaParseReader({
    resultType: "json",
  });

  // Load data from the temporary file
  const json = await reader.loadJson(tempFilePath);
  const images = await reader.getImages(json, tempImageDir);

  // Clean up the temporary file
  //await fs.remove(tempFilePath);

  return { message: "Processed file", json, images };
}

async function getAnthropicCompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number
) {
  const completion = await anthropic.messages.create({
    max_tokens: 8192,
    system: [{ type: "text", text: systemPrompt }],
    model: model,
    temperature: temperature,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
  });

  const completionText = (completion.content[0] as Anthropic.TextBlock).text;
  return completionText;
}

async function getWebContext(
  link: string
): Promise<{ url: string; markdown: string }[]> {
  const result = await firecrawl.search(link);

  if ("data" in result) {
    const data: { url: string; markdown: string }[] = [];

    result.data.forEach((item: { url: string; markdown: string }) => {
      const cleanedMarkdown = item.markdown
        .replace(/<br\s*\/?>/gi, "")
        .replace(/\[.*?\]\(.*?\)/g, "")
        .replace(/\s{2,}/g, " ")
        .replace(/\n{2,}/g, "\n");
      data.push({ url: item.url, markdown: cleanedMarkdown });
    });

    return data;
  } else {
    throw new Error("Failed to scrape content");
  }
}
