import fs from "fs-extra";
import path from "path"; // Adjust the import path as necessary
import { uploadFile } from "@aws/s3";
import { synthesizeSpeechInChunks } from "@utils/polly";

interface Item {
  type: string;
  content: string;
  label?: { labelType: string; labelNumber: string };
  summary?: string;
  optimizedMath?: boolean;
  replacedCitations?: Boolean;
  repositioned?: Boolean;
  page: number;
  mathSymbolFrequency?: number;
  hasCitations?: boolean;
  isStartCutOff?: boolean;
  isEndCutOff?: boolean;
  allAbbreviations?: {
    abbreviation: string;
    expansion: string;
    type: "pronounced_as_a_single_word" | "pronounced_with_initials";
  }[];
}

async function generateAudioFromFilteredItems(
  jsonFilePath: string
): Promise<void> {
  try {
    // Read the JSON file
    const filteredItems: Item[] = await fs.readJson(jsonFilePath);

    // Generate audio using synthesizeSpeechInChunks
    const { audioBuffer, audioMetadata } = await synthesizeSpeechInChunks(
      filteredItems
    );

    const email = "babak@extrayear.ai";
    const fileName = "Ten-Year Effects";

    const audioFileName = `${email}/${fileName}.mp3`;

    // Upload the audio buffer directly to S3
    const audioFileUrl = await uploadFile(audioBuffer, audioFileName);

    // Optionally, upload the audio metadata to S3
    const metadataFileName = `${email}/${fileName}.json`;
    const metadataBuffer = Buffer.from(JSON.stringify(audioMetadata));
    const metadataFileUrl = await uploadFile(metadataBuffer, metadataFileName);
  } catch (error) {
    console.error("Error generating audio from filtered items:", error);
  }
}

generateAudioFromFilteredItems("src/manual/manualItems.json");
