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
import { pdfToPng } from "pdf-to-png-converter";

interface SummarizeRequestParams {
  summarizationMethod:
    | "betterAbstract"
    | "twoPage"
    | "chaptered"
    | "tablesAndFiguresOnly"
    | "ultimate";
}

type Model =
  | "claude-3-5-sonnet-20240620"
  | "gpt-4o-2024-08-06"
  | "gpt-4o-mini-2024-07-18"
  | "claude-3-haiku-20240307";

const modelConfig: {[task: string]: {temperature: number, model: Model}} = {
  extraction: {
    temperature: 0.5,
    model: "claude-3-5-sonnet-20240620"
  },
  summarization: {
    temperature: 1,
    model: "gpt-4o-2024-08-06"
  },
  cleanup: {
    temperature: 0,
    model: "gpt-4o-2024-08-06"
  },
  math: {
    temperature: 0,
    model: "claude-3-5-sonnet-20240620"
  }

}

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

/*
Algorithm:
1. Extract raw text 
2. Summarize figures/tables
3. Insert figures/tables at the right spot
4. Clean up
*/

export default async function handler(
  request: FastifyRequest<{
    Querystring: SummarizeRequestParams;
  }>,
  reply: FastifyReply
) {
  const { summarizationMethod } = request.query;
  const fileBuffer = request.body as Buffer;

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
  const tempObjectsDir = path.join(tempDir, "objects");

  clearDirectory(tempImageDir);

  if (!fs.existsSync(tempImageDir)) {
    fs.mkdirSync(tempImageDir);
  }

  if (!fs.existsSync(audioOutputDir)) {
    fs.mkdirSync(audioOutputDir);
  }

  if (!fs.existsSync(ttsTextDir)) {
    fs.mkdirSync(ttsTextDir);
  }

  if (!fs.existsSync(tempObjectsDir)) {
    fs.mkdirSync(tempObjectsDir);
  }

  console.log("attempting to convert pdf pages to images");
  const pngPages = await pdfToPng(fileBuffer, {
    viewportScale: 2.0,
    outputFolder: tempImageDir,
  });
  console.log("converted pdf pages to images");

  if (summarizationMethod === "ultimate") {

    //extract
    let pageText: string[] = [];
    for (const [index, pngPage] of pngPages.entries()) {
      console.log("processing page ", index + 1);
      const pagePath = pngPage.path;
      const pageContent = await getCompletion(
        EXTRACT_PROMPT,
        `Here is the page`,
        modelConfig.extraction.model,
        modelConfig.extraction.temperature,
        "page",
        pagePath
      );

      // console.log("cleaning up page", index + 1);
      // const improvedPageContent = await getCompletion(
      //   CLEANUP_PROMPT,
      //   pageContent,
      //   modelConfig.cleanup.model,
      //   modelConfig.cleanup.temperature,
      //   "page",
      //   pagePath
      // );

      // pageText.push(improvedPageContent);
      pageText.push(pageContent);
      console.log("processed page ", index + 1);
    }

    const pageTextString = pageText.join("")

    const rawTextFilePath = path.join(ttsTextDir, "raw-textract.txt");
    fs.writeFileSync(rawTextFilePath, pageTextString);
    console.log("Saved raw text extract to", rawTextFilePath);

    //summarize
    const summarizationSchema = z.object({ summarizedItems: z.array(
      z.object({
        keywords: z.array(z.string()),
        label: z.string(),
        summary: z.string(),
      })
    )});

    const imagePaths = pngPages.map(page => page.path)

    const summarizationCompletion = await getStructuredOpenAICompletion(
      SUMMARIZATION_PROMPT,
      "",
      modelConfig.summarization.model,
      modelConfig.summarization.temperature,
      summarizationSchema,
      imagePaths
    )

    const summarizedItems = summarizationCompletion?.summarizedItems
    const summarizedItemsFilePath = path.join(tempObjectsDir, "summarizedItems.json");
    fs.writeFileSync(summarizedItemsFilePath, JSON.stringify(summarizedItems, null, 2));
    console.log("Saved summarized items to", summarizedItemsFilePath);

    //place
    let paragraphs = pageTextString.split(/\n{2,}/); //not exact paragraphs
    for (const item of summarizedItems) {
      const label = item.label;
      const summary = item.summary;
      const keywords = item.keywords.map((keyword: string) => keyword.toLowerCase());
    
      let placed = false;
      for (let i = 0; i < paragraphs.length; i++) {
        if (paragraphs[i].toLowerCase().includes(label.toLowerCase())) {
          paragraphs[i] = `${label} summary:\n${summary}\n\n${paragraphs[i]}`;
          placed = true;
          break; // Stop after placing the summary once
        }
      }
    
      if (!placed) {
        for (let i = 0; i < paragraphs.length; i++) {
          if (keywords.some((keyword: string) => paragraphs[i].toLowerCase().includes(keyword))) {
            paragraphs.splice(i, 0, `${label} summary:\n${summary}`);
            break; // Stop after placing the summary once
          }
        }
      }
    }
    
    // Join paragraphs back into a single string
    const pageTextStringWithItems = paragraphs.join('\n\n');

    //cleanup



    console.log("attempting to combine text for TTS");
    let ttsText = pageTextStringWithItems;

    console.log("combined text for TTS");
    const ttsTextFilePath = path.join(ttsTextDir, "tts-text.txt");
    fs.writeFileSync(ttsTextFilePath, ttsText);

    // const ttsTextFilePath = path.join(ttsTextDir, "tts-text.txt");
    // const ttsText = fs.readFileSync(ttsTextFilePath, "utf-8");

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
  schema: z.AnyZodObject,
  imagePaths: string[] = []
) {
  const imageMessages: ChatCompletionMessageParam[] = imagePaths.map((imagePath) => {
    const imageBuffer = fs.readFileSync(imagePath);
    const mediaType = mime.getType(imagePath);
    const base64Image = imageBuffer.toString("base64");
    return {
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
    };
  });

  const completion = await openai.beta.chat.completions.parse({
    model: model,
    temperature: temperature,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      ...imageMessages,
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

function clearDirectory(directoryPath: string) {
  if (fs.existsSync(directoryPath)) {
    fs.readdirSync(directoryPath).forEach((file) => {
      const filePath = path.join(directoryPath, file);
      if (fs.lstatSync(filePath).isDirectory()) {
        clearDirectory(filePath);
        fs.rmdirSync(filePath);
      } else {
        fs.unlinkSync(filePath);
      }
    });
  }
}

/*PROMPTS*/

const EXTRACT_PROMPT = `Extract the text of this page accurately. I want the entire text.
Exclude images, tables and figures. Exclude any captions, descriptions or notes for the images, tables or figures.
Include cut off sentences or words at the bottom and top edge of the page. Do not include the page numbers.
Put the entire output in <page> xml tags.`;

const SUMMARIZATION_PROMPT = `Summarize the tables and figures in the provided pages. The summary should be detailed and describe what the figure or table is trying to convey. Also make sure to grab the correct label.`;

const CLEANUP_PROMPT = `The given page will be converted to audio. It may have multiple issues that prevent it from being suitable for audio that you need to fix. Please clean up the given page in the following ways:

- Remove anything before the abstract other than the tite, author's name or affiliations.
- Remove any meta-information.
- Each author's name should be followed by their affiliation, do not group the names together followed by grouped affiliations.
- If there are too many mathematical expressions in a section replace it with a summary under the heading "The following section had too many math expressions making it unsuitable for audio, so here is a summary: ".
- If there are just one or two equations then don't summarize it. Instead, enclose all variables and constant letters in the math expression within "" and convert it to words as much as possible. For example, add "times" where multiplication is implied.
- Remove superscripts and subscripts outside math expressions
- Remove the references section.
- Unhyphenate words that are split between lines
- If you see any <figure>, <table> or <image> elements, reposition them in a more appropriate place. Do this if these elements split a paragraph in the middle as well. This will make more sense when the user is listening.
- If there is any figure, table or image caption/note/description from the original text still remaining remove them. I only want tags.
- Remove citation numbers like [x] or in any other format.

Return the improved page extract in <page> xml tags.`;

const PAGE_IMPROVEMENT_PROMPT = `The user will provide you with a page and its text extract. The given text extract will converted to audio. It may have multiple issues that prevent it from being suitable for audio that you need to fix.

- If it is a paper, remove anything before the abstract that is not the title, authors' names or affiliations. Remove any meta-information.
- Each author's name should be followed by their affiliation instead of grouping all the author names together
- Remove superscripts and subscripts from text that is not part of math expression.
- Remove citation numbers like [x]. In general, remove any artifacts from the output that will degrade the audio experience. 
- Fix any inaccuracies in parsing the text.
- Unhyphenate words that are split between lines
- If you see any <figure>, <table> or <image> elements, reposition them in a more appropriate place like when it is first mentioned. Do this if these elements split a paragraph in the middle as well. This will make more sense when the user is listening.
- Improve the <figure>, <table> or <image> elements which are summaries of the raw images, figures or tables in the page. 
- Mathematical expressions are really hard to listen to. You need to convert it to words as much as possible. For example, multiplication is often implied however for listening you should add "times" where necessary to improve the experience. 
- Make sure the <figure>, <table> or <image> numbers are accurate.
- If there is any figure, table or image caption/note from the original text still remaining remove them as they do not make sense with respect to the summarized elements.
- Remove the references section.

Return the improved page extract in <page> xml tags.
`;
