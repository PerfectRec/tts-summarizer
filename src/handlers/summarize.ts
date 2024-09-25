import { FastifyRequest, FastifyReply } from "fastify";
import { fileURLToPath } from "url";
import { LlamaParseReader } from "llamaindex";
import Anthropic from "@anthropic-ai/sdk";
import FirecrawlApp, { FirecrawlDocument } from "@mendable/firecrawl-js";
import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import os from "os";
import { ImageBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import mime from "mime";
import { synthesizeSpeech } from "@aws/polly";
import { OpenAI } from "openai";
import { ChatCompletionMessageParam } from "openai/resources";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

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

type Model =
  | "claude-3-5-sonnet-20240620"
  | "gpt-4o-2024-08-06"
  | "gpt-4o-mini-2024-07-18"
  | "claude-3-haiku-20240307";

const BIG_MODEL_TEMPERATURE = 0;
const BIG_MODEL = "gpt-4o-2024-08-06";

const SMALL_MODEL_TEMPERATURE = 0;
const SMALL_MODEL = "gpt-4o-mini-2024-07-18";

const MAX_POLLY_CHAR_LIMIT = 1500;

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY,
});

const anthropic = new Anthropic({
  baseURL: "https://anthropic.helicone.ai",
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15",
    "Helicone-Auth": `Bearer ${process.env.HELICONE_API_KEY}`,
  },
});

const openai = new OpenAI({
  baseURL: "https://oai.helicone.ai/v1",
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: {
    "Helicone-Auth": `Bearer ${process.env.HELICONE_API_KEY}`,
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

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const projectRoot = path.resolve(__dirname, "../..");
  const tempDir = path.join(projectRoot, "temp");

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const tempImageDir = path.join(tempDir, "images-temp");
  const audioOutputDir = path.join(tempDir, "audio-output");
  const ttsTextDir = path.join(tempDir, "tts-text");

  if (!fs.existsSync(tempImageDir)) {
    fs.mkdirSync(tempImageDir);
  }

  if (!fs.existsSync(audioOutputDir)) {
    fs.mkdirSync(audioOutputDir);
  }

  if (!fs.existsSync(ttsTextDir)) {
    fs.mkdirSync(ttsTextDir);
  }

  // Instantiate LlamaParseReader
  const reader = new LlamaParseReader({
    resultType: "json",
  });

  // Load data from the temporary file
  const json = await reader.loadJson(fileBuffer);
  const pages: Pages = json[0].pages;
  const images = await reader.getImages(json, tempImageDir);
  const imagesMap: Map<string, Image> = new Map(
    images.map((image: Image) => [image.name, image])
  );

  const entirePaperMd = pages.map((page) => page.md).join("\n\n");

  console.log("Converted to JSON and images");

  let ttsText;
  let title;
  let webContext;
  let betterAbstract;
  let abstractNotFoundInItems = true;

  if (summarizationMethod === "ultimate") {
    let tableCounter = 0;
    let imageCounter = 0;

    //page processing loop
    for (const page of pages) {
      if (page.page === 1) {
        title = await getCompletion(
          "Extract the title of the work from the following markdown content. Only return the title in <title></title>",
          page.md,
          BIG_MODEL,
          BIG_MODEL_TEMPERATURE,
          "title"
        );

        console.log("Detected title: ", title);

        try {
          webContext = await getWebContext(title + " signficance");
          console.log("Grabbed search results");
        } catch (error) {
          console.log("Firecrawl crashed");
          webContext = "";
        }
      }

      //item loop
      for (const [index, item] of page.items.entries()) {
        //generate the better abstract using the previously collected web context and title
        if (
          page.items[index - 1]?.type === "heading" &&
          page.items[index - 1]?.value?.toLocaleLowerCase().includes("abstract")
        ) {
          console.log("attempting to generate better abstract");

          betterAbstract = await getCompletion(
            "Based on the original extract and web context about the given work, generate a better and more contextual abstract that does a better job of introducing the reader to the work. Return the output in <betterAbstract></betterAbstract>",
            `Original abstract:\n${item.md}\n\nWeb context about ${title}:\n${webContext}\n\nEntire paper:\n${entirePaperMd}`,
            BIG_MODEL,
            BIG_MODEL_TEMPERATURE,
            "betterAbstract"
          );

          item.betterMd = betterAbstract;
          console.log("generated better abstract");
          abstractNotFoundInItems = false;
        }

        //process tables
        if (item.type === "table") {
          tableCounter++;
          console.log("Attempting to summarize table ", tableCounter);
          const tableSummary = await getCompletion(
            "Summarize the following table content. Provide a concise summary that captures the key points and insights from the table. Use the entire page as context. Return the output in <tableSummary></tableSummary>",
            `Table:\n${item.md}\n\nEntire Page:\n${page.md}`,
            BIG_MODEL,
            BIG_MODEL_TEMPERATURE,
            "tableSummary"
          );

          item.summary = tableSummary;
          item.tableNumber = tableCounter;
          console.log("Summarized table ", tableCounter);
        }
      }

      //image loop
      for (const image of page.images) {
        imageCounter++;
        console.log("attempting to summarize image ", imageCounter);
        const savedImage = imagesMap.get(image.name);
        if (savedImage) {
          const imagePath = savedImage.path;
          console.log(imagePath);
          const imageSummary = await getCompletion(
            "Summarize the content of the following image. Provide a concise summary that captures the key points and insights from the image. Return the output in <imageSummary></imageSummary>",
            `Title: ${title}\n\nPage context:\n${page.md}`,
            BIG_MODEL,
            BIG_MODEL_TEMPERATURE,
            "imageSummary",
            imagePath
          );
          image.summary = imageSummary;
        }
        image.imageNumber = imageCounter;
        console.log("Summarized image ", imageCounter);
      }
    }

    if (abstractNotFoundInItems) {
      for (const page of pages) {
        if (page.text.toLocaleLowerCase().includes("abstract")) {
          console.log(
            "Abstract found in page text instead of markdown, generating better abstract"
          );

          betterAbstract = await getCompletion(
            "Based on the original extract and web context about the given work, generate a better and more contextual abstract that does a better job of introducing the reader to the work. Return the output in <betterAbstract></betterAbstract>",
            `Original abstract:\n${page.text}\n\nWeb context about ${title}:\n${webContext}\n\nEntire paper:\n${entirePaperMd}`,
            BIG_MODEL,
            BIG_MODEL_TEMPERATURE,
            "betterAbstract"
          );

          console.log("Generated better abstract from page markdown");
          break;
        }
      }
    }

    //page combination loop
    let combinedText = "";
    console.log("attempting to combine text for TTS");

    if (abstractNotFoundInItems && betterAbstract) {
      combinedText += `Abstract: ${betterAbstract}\n\n`;
    }

    for (const page of pages) {
      //image summaries should go first as they are usually first in the page
      for (const image of page.images) {
        combinedText += image.summary
          ? `Image ${image.imageNumber}: ${image.summary}\n\n`
          : "\n\n";
      }

      for (const [index, item] of page.items.entries()) {
        if (
          page.items[index - 1]?.type === "heading" &&
          page.items[index - 1]?.value?.toLocaleLowerCase().includes("abstract")
        ) {
          combinedText += item.betterMd + "\n\n" || item.md + "\n\n";
        } else if (item.type === "table") {
          combinedText += item.summary
            ? `Table ${item.tableNumber}: ${item.summary}\n\n`
            : item.value + "\n\n";
        } else {
          combinedText += item.md + "\n\n";
        }
      }
    }
    ttsText = combinedText.replace(/#/g, "");
    console.log("combined text for TTS");
    const ttsTextFilePath = path.join(ttsTextDir, "tts-text.txt");
    fs.writeFileSync(ttsTextFilePath, ttsText);

    try {
      throw new Error("Audio generation skipped");
      const audioBuffer = await synthesizeSpeechInChunks(ttsText);
      console.log("Generated audio file");

      const audioFilePath = path.join(audioOutputDir, "output.mp3");
      fs.writeFileSync(audioFilePath, audioBuffer);
      console.log("Saved audio file to", audioFilePath);

      // Send the audio file as a response
      return reply.type("audio/mpeg").send(audioBuffer);
    } catch (error) {
      console.error("Error generating audio file:", error);
      return reply.status(500).send({ message: "Error generating audio file" });
    }
  } else {
    return reply
      .status(400)
      .send({ message: "This summarization method is not supported yet!" });
  }
}

async function getWebContext(link: string): Promise<string> {
  console.log("Searching the web for: ", link);
  const result = await firecrawl.search(link);

  //console.log(JSON.stringify(result, null, 2));

  if (result.data) {
    let combinedData = "";

    result.data
      .filter(
        (item: { url?: string }) => item.url && !item.url.includes("youtube")
      )
      .slice(0, 5)
      .forEach((item: FirecrawlDocument) => {
        if (item.markdown) {
          const cleanedMarkdown = item.markdown
            .replace(/<br\s*\/?>/gi, "")
            .replace(/\[.*?\]\(.*?\)/g, "")
            .replace(/\s{2,}/g, " ")
            .replace(/\n{2,}/g, "\n");
          if (item.url) {
            combinedData += `${item.url}\n${cleanedMarkdown}\n\n`;
          }
        }
      });
    return combinedData.trim();
  } else {
    throw new Error("Failed to scrape content");
  }
}

function splitTextIntoChunks(text: string, maxLength: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxLength) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

async function synthesizeSpeechInChunks(text: string): Promise<Buffer> {
  const chunks = splitTextIntoChunks(text, MAX_POLLY_CHAR_LIMIT);
  const audioBuffers: Buffer[] = [];

  for (const chunk of chunks) {
    const audioBuffer = await synthesizeSpeech(chunk);
    audioBuffers.push(audioBuffer);
  }

  return Buffer.concat(audioBuffers);
}

async function getAnthropicCompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number,
  xmlTag: string,
  imagePath?: string
) {
  let messages: MessageParam[];

  if (imagePath) {
    const imageBuffer = fs.readFileSync(imagePath);
    const mediaType = mime.getType(imagePath);
    messages = [
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image",
            source: {
              data: imageBuffer.toString("base64"),
              media_type: mediaType,
              type: "base64",
            },
          } as ImageBlockParam,
        ],
      },
    ];
  } else {
    messages = [
      {
        role: "user",
        content: userPrompt,
      },
    ];
  }

  const completion = await anthropic.messages.create({
    max_tokens: 8192,
    system: [{ type: "text", text: systemPrompt }],
    model: model,
    temperature: temperature,
    messages: messages,
  });

  const completionText = (completion.content[0] as Anthropic.TextBlock).text;
  const regex = new RegExp(`<${xmlTag}>([\\s\\S]*?)</${xmlTag}>`);
  const match = completionText.match(regex);
  const parsedCompletion = match ? match[1] : completionText;

  return parsedCompletion;
}

async function getOpenAICompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number,
  xmlTag: string,
  imagePath?: string
) {
  let messages: ChatCompletionMessageParam[];

  if (imagePath) {
    const imageBuffer = fs.readFileSync(imagePath);
    const mediaType = mime.getType(imagePath);
    const base64Image = imageBuffer.toString("base64");
    messages = [
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image_url",
            image_url: {
              url: `data:${mediaType};base64,${base64Image}`,
            },
          },
        ],
      },
    ];
  } else {
    messages = [
      {
        role: "user",
        content: userPrompt,
      },
    ];
  }

  const completion = await openai.chat.completions.create({
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      ...messages,
    ],
    model: model,
    temperature: temperature,
  });

  const completionText = completion.choices[0].message.content!;
  const regex = new RegExp(`<${xmlTag}>([\\s\\S]*?)</${xmlTag}>`);
  const match = completionText.match(regex);
  const parsedCompletion = match ? match[1] : completionText;

  return parsedCompletion;
}

async function getCompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number,
  xmlTag: string,
  imagePath?: string
) {
  if (model.includes("gpt")) {
    return getOpenAICompletion(
      systemPrompt,
      userPrompt,
      model,
      temperature,
      xmlTag,
      imagePath
    );
  } else if (model.includes("claude")) {
    return getAnthropicCompletion(
      systemPrompt,
      userPrompt,
      model,
      temperature,
      xmlTag,
      imagePath
    );
  } else {
    throw new Error("Unsupported model type");
  }
}

async function getStructuredOpenAICompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number,
  schema: z.AnyZodObject
) {
  const completion = await openai.beta.chat.completions.parse({
    model: model,
    temperature: temperature,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    response_format: zodResponseFormat(schema, "schema"),
  });

  const response = completion.choices[0].message;

  if (response.refusal) {
    throw new Error(response.refusal);
  } else {
    return response.parsed;
  }
}
