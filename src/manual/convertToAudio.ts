import fs from "fs-extra";
import path from "path";
import { synthesizeSpeechInChunks } from "../handlers/highQualitySummarize"; // Adjust the import path as necessary

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

    // Define the output paths
    const audioOutputPath = path.join(
      path.dirname(jsonFilePath),
      "outputAudio.mp3"
    );
    const metadataOutputPath = path.join(
      path.dirname(jsonFilePath),
      "audioMetadata.json"
    );

    // Save the audio buffer to a file
    await fs.writeFile(audioOutputPath, audioBuffer);

    // Save the audio metadata to a file
    await fs.writeJson(metadataOutputPath, audioMetadata);

    console.log(
      `Audio and metadata have been saved to ${audioOutputPath} and ${metadataOutputPath}`
    );
  } catch (error) {
    console.error("Error generating audio from filtered items:", error);
  }
}

generateAudioFromFilteredItems("src/manual/manualItems.json");
