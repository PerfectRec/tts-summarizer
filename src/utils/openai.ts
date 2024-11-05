import "dotenv/config";
import mime from "mime";
import fs from "fs-extra";
import { z } from "zod";
import { OpenAI } from "openai";
import {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources";
import { convertBreaks } from "./ssml";
import { zodResponseFormat } from "openai/helpers/zod";

type OpenAIVoice = "alloy" | "onyx" | "echo" | "fable" | "shimmer" | "nova";

const openai = new OpenAI({
  baseURL: "https://oai.helicone.ai/v1",
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: {
    "Helicone-Auth": `Bearer ${process.env.HELICONE_API_KEY}`,
  },
});

export async function getStructuredOpenAICompletion(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number,
  schema: z.AnyZodObject,
  imagePaths: string[] = [],
  maxTokens: number = 16384,
  frequencyPenalty: number = 0
) {
  const imageUrls = imagePaths.map((imagePath) => {
    const imageBuffer = fs.readFileSync(imagePath);
    const mediaType = mime.getType(imagePath);
    const base64Image = imageBuffer.toString("base64");
    return {
      type: "image_url",
      image_url: {
        url: `data:${mediaType};base64,${base64Image}`,
      },
    } as ChatCompletionContentPart;
  });

  const messages: ChatCompletionMessageParam[] =
    imagePaths.length > 0
      ? [
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }, ...imageUrls],
          },
        ]
      : [
          {
            role: "user",
            content: userPrompt,
          },
        ];

  const completion = await openai.beta.chat.completions.parse({
    model: model,
    temperature: temperature,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      ...messages,
    ],
    response_format: zodResponseFormat(schema, "schema"),
    max_tokens: maxTokens,
    frequency_penalty: frequencyPenalty,
  });

  const response = completion.choices[0].message;

  if (response.refusal) {
    throw new Error(response.refusal);
  } else {
    return response.parsed;
  }
}

export async function synthesizeOpenAISpeech(
  text: string,
  voice: OpenAIVoice
): Promise<Buffer> {
  const mp3 = await openai.audio.speech.create({
    model: "tts-1-hd",
    voice: voice,
    input: text,
  });
  return Buffer.from(await mp3.arrayBuffer());
}

export async function synthesizeSpeechInChunksOpenAI(
  items: Item[]
): Promise<Buffer> {
  const audioBuffers: Buffer[] = [];
  const MAX_CONCURRENT_ITEMS = 20;

  const processItem = async (item: Item) => {
    let audioBuffer: Buffer;

    if (
      ["figure_image", "table_rows", "code_or_algorithm"].includes(item.type)
    ) {
      audioBuffer = await synthesizeOpenAISpeech(
        convertBreaks(item.content),
        "onyx"
      );
    } else {
      audioBuffer = await synthesizeOpenAISpeech(
        convertBreaks(item.content),
        "alloy"
      );
    }

    return audioBuffer;
  };

  for (let i = 0; i < items.length; i += MAX_CONCURRENT_ITEMS) {
    const itemBatch = items.slice(i, i + MAX_CONCURRENT_ITEMS);
    console.log(
      `converting items ${i} through ${i + MAX_CONCURRENT_ITEMS} to audio`
    );
    const batchResults = await Promise.all(itemBatch.map(processItem));
    audioBuffers.push(...batchResults);
  }

  return Buffer.concat(audioBuffers);
}

export async function getOpenAICompletion(
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
