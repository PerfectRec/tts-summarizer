import { synthesizeSpeech } from "@aws/polly";
import { parseBuffer } from "music-metadata";
import { convertBreaks, escapeSSMLCharacters, removeBreaks } from "./ssml";
import "dotenv/config";

const MAX_POLLY_CHAR_LIMIT = 2900;

type PollyLongFormVoices = "Ruth" | "Gregory" | "Danielle";
type PollyGenerativeVoices = "Ruth" | "Matthew" | "Stephen";

function splitTextIntoChunks(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

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

export async function synthesizeSpeechInChunks(
  items: Item[]
): Promise<AudioResult> {
  const itemAudioResults: ItemAudioResult[] = [];
  const MAX_CONCURRENT_ITEMS = 15;

  const processItem = async (item: Item) => {
    const chunkAudioBuffers: Buffer[] = [];

    if (
      //Use Matthew for other generated content.
      ["code_or_algorithm", "figure_image", "table_rows"].includes(item.type)
    ) {
      const chunks = splitTextIntoChunks(item.content, MAX_POLLY_CHAR_LIMIT);
      for (const chunk of chunks) {
        const ssmlChunk = `<speak>${convertBreaks(
          escapeSSMLCharacters(chunk)
        )}</speak>`;
        const audioBuffer = await synthesizeSpeech(ssmlChunk, "Matthew", true);
        chunkAudioBuffers.push(audioBuffer);
      }
    } else {
      // Use "Ruth" for narrated content
      const chunks = splitTextIntoChunks(item.content, MAX_POLLY_CHAR_LIMIT);
      for (const chunk of chunks) {
        const ssmlChunk = `<speak>${convertBreaks(
          escapeSSMLCharacters(chunk)
        )}</speak>`;
        const audioBuffer = await synthesizeSpeech(ssmlChunk, "Ruth", true);
        chunkAudioBuffers.push(audioBuffer);
      }
    }

    const itemAudioBuffer = Buffer.concat(chunkAudioBuffers);

    const itemMetadata = await parseBuffer(itemAudioBuffer);

    const itemAudioMetadata: ItemAudioMetadata = {
      type: item.type,
      startTime: 0,
      itemDuration: itemMetadata.format.duration || 0,
      transcript: removeBreaks(item.content),
      page: item.page,
      index: 0,
      audioIssues: item.audioIssues || [],
    };

    return { itemAudioBuffer, itemAudioMetadata };
  };

  for (let i = 0; i < items.length; i += MAX_CONCURRENT_ITEMS) {
    const itemBatch = items.slice(i, i + MAX_CONCURRENT_ITEMS);
    console.log(
      `converting items ${i} through ${i + MAX_CONCURRENT_ITEMS} to audio`
    );
    const batchResults = await Promise.all(itemBatch.map(processItem));
    itemAudioResults.push(...batchResults);
  }

  const audioBuffer = Buffer.concat(
    itemAudioResults.map((itemAudioResult) => itemAudioResult.itemAudioBuffer)
  );

  const audioMetadata = itemAudioResults.map(
    (itemAudioResult) => itemAudioResult.itemAudioMetadata
  );

  //We need to adjust the start times here
  let startTime = 0;
  let index = 0;
  let audioDuration = 0;
  for (const itemMetadata of audioMetadata) {
    itemMetadata.startTime = startTime;
    itemMetadata.index = index;
    index += 1;
    startTime += itemMetadata.itemDuration;
    audioDuration += itemMetadata.itemDuration;
  }

  const tocAudioMetadata = audioMetadata.filter(
    (item) =>
      item.type.includes("heading") ||
      ["main_title", "end_marker"].includes(item.type)
  );

  return {
    audioBuffer: audioBuffer,
    audioMetadata: audioMetadata,
    audioDuration: audioDuration,
    tocAudioMetadata: tocAudioMetadata,
  };
}
