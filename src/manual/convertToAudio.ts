import fs from "fs-extra";
import path from "path"; // Adjust the import path as necessary
import { uploadFile } from "@aws/s3";
import { synthesizeSpeechInChunks } from "@utils/polly";
import { synthesizeSpeechInChunksOpenAI } from "@utils/openai";

async function generateAudioFromFilteredItems(
  jsonFilePath: string
): Promise<void> {
  try {
    // Read the JSON file
    const filteredItems: Item[] = await fs.readJson(jsonFilePath);

    // Generate audio using synthesizeSpeechInChunks
    const { audioBuffer, audioMetadata, tocAudioMetadata } =
      await synthesizeSpeechInChunksOpenAI(filteredItems);

    const userBucketName = "muralirk@gmail.com";
    const fileName = "Verus";

    const audioFileName = `${userBucketName}/${fileName}.mp3`;

    // Upload the audio buffer directly to S3
    const audioFileUrl = await uploadFile(audioBuffer, audioFileName);

    // Optionally, upload the audio metadata to S3
    const metadataFileName = `${userBucketName}/${fileName}-metadata.json`;
    const metadataBuffer = Buffer.from(
      JSON.stringify(
        {
          segments: audioMetadata,
          tableOfContents: tocAudioMetadata,
        },
        null,
        2
      )
    );
    const metadataFileUrl = await uploadFile(metadataBuffer, metadataFileName);
  } catch (error) {
    console.error("Error generating audio from filtered items:", error);
  }
}

generateAudioFromFilteredItems("src/manual/manualItems.json");
