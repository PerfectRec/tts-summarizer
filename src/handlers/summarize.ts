import { FastifyRequest, FastifyReply } from "fastify";
import { LlamaParseReader } from "llamaindex";
import Anthropic from "@anthropic-ai/sdk";
import FirecrawlApp from "@mendable/firecrawl-js";
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import os from "os";
import { ImageBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import mime from "mime";

interface SummarizeRequestParams {
  summarizationMethod:
    | "betterAbstract"
    | "twoPage"
    | "chaptered"
    | "tablesAndFiguresOnly"
    | "ultimate";
}

//Types for the LlamaParse JSON output
interface BoundingBox {
  x: number | null;
  y: number;
  w: number;
  h: number;
}

interface Item {
  type: string;
  value?: string;
  md: string;
  bBox: BoundingBox;
  lvl?: number;
  [key: string]: any; // Allow for additional properties
}

interface Page {
  page: number;
  items: Item[];
  [key: string]: any; // Allow for additional properties
}

export interface Image {
  name: string;
  height: number;
  width: number;
  x: number;
  y: number;
  original_width: number;
  original_height: number;
  path: string;
  job_id: string;
  original_pdf_path: string;
  page_number: number;
}

type Pages = Page[];

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
  const pages: Pages = await reader.loadJson(tempFilePath);
  const images = await reader.getImages(pages, tempImageDir);
  const imagesMap: Map<string, Image> = new Map(
    images.map((image: Image) => [image.name, image])
  );

  if (summarizationMethod === "ultimate") {
    for (const page of pages) {
      let title;
      let webContext;

      if (page.page === 1) {
        title = await getAnthropicCompletion(
          "Extract the title of the work from the following markdown content. Only return the title in <title></title>",
          page.md,
          ANTHROPIC_MODEL,
          ANTHROPIC_TEMPERATURE,
          "title"
        );

        webContext = await getWebContext(title);
      }

      //item loop
      for (const item of page.items) {
        //generate the better abstract using the previously collected web context and title
        if (
          item.type === "heading" &&
          item.value?.toLocaleLowerCase().includes("abstract")
        ) {
          const betterAbstract = await getAnthropicCompletion(
            "Based on the original extract and web context about the given work, generate a better and more contextual abstract that does a better job of introducing the reader to the work. Make sure to note if the paper is significant and why. Return the output in <betterAbstract></betterAbstract>",
            `Original abstract:\n${item.md}\n\nWeb context about ${title}:\n${webContext}`,
            ANTHROPIC_MODEL,
            ANTHROPIC_TEMPERATURE,
            "betterAbstract"
          );

          item.betterMd = betterAbstract;
        }

        //process tables
        if (item.type === "table") {
          const tableSummary = await getAnthropicCompletion(
            "Summarize the following table content. Provide a concise summary that captures the key points and insights from the table. Use the entire page as context. Return the output in <tableSummary></tableSummary>",
            `Table:\n${item.md}\n\nEntire Page:\n${page.md}`,
            ANTHROPIC_MODEL,
            ANTHROPIC_TEMPERATURE,
            "tableSummary"
          );

          item.summary = tableSummary;
        }
      }

      //image loop
      for (const image of page.images) {
        const savedImage = imagesMap.get(image.name);
        if (savedImage) {
          const imagePath = savedImage.path;
          const imageSummary = await getAnthropicCompletion(
            "Summarize the content of the following image. Provide a concise summary that captures the key points and insights from the image. Return the output in <imageSummary></imageSummary>",
            `Title: ${title}\n\nPage context:\n${page.md}`,
            ANTHROPIC_MODEL,
            ANTHROPIC_TEMPERATURE,
            "imageSummary",
            imagePath
          );
          image.summary = imageSummary;
        }
      }
    }
  } else {
    return { message: "This summarization method is not supported yet!" };
  }

  // Clean up the temporary file
  //await fs.remove(tempFilePath);

  return { message: "Generated audio file", pages, images };
}

async function getAnthropicCompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number,
  xmlTag: string,
  imagePath?: string
) {
  const messages: MessageParam[] = [
    {
      role: "user",
      content: userPrompt,
    },
  ];

  if (imagePath) {
    const imageBuffer = fs.readFileSync(imagePath);
    const mediaType = mime.getType(imagePath);
    messages.push({
      role: "user",
      content: [
        {
          type: "image",
          source: {
            data: imageBuffer.toString("base64"),
            media_type: mediaType,
            type: "base64",
          },
        } as ImageBlockParam,
      ],
    });
  }

  const completion = await anthropic.messages.create({
    max_tokens: 8192,
    system: [{ type: "text", text: systemPrompt }],
    model: model,
    temperature: temperature,
    messages: messages,
  });

  const completionText = (completion.content[0] as Anthropic.TextBlock).text;
  const regex = new RegExp(`<${xmlTag}>(.*?)</${xmlTag}>`);
  const match = completionText.match(regex);
  const parsedCompletion = match ? match[1] : completionText;

  return parsedCompletion;
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
