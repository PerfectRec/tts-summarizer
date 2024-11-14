import { UnstructuredClient } from "unstructured-client";
import { PartitionResponse } from "unstructured-client/sdk/models/operations";
import { Strategy } from "unstructured-client/sdk/models/shared";

const client = new UnstructuredClient({
  serverURL: process.env.UNSTRUCTURED_API_URL,
  security: {
    apiKeyAuth: process.env.UNSTRUCTURED_API_KEY,
  },
});

export async function processUnstructuredBuffer(
  fileBuffer: Buffer,
  fileName: string
): Promise<any> {
  try {
    const res: PartitionResponse = await client.general.partition({
      partitionParameters: {
        files: {
          content: fileBuffer,
          fileName: fileName,
        },
        strategy: Strategy.HiRes,
        splitPdfPage: true,
        splitPdfAllowFailed: true,
        splitPdfConcurrencyLevel: 15,
        languages: ["eng"],
        extractImageBlockTypes: ["Image", "Table"],
      },
    });

    if (res.statusCode === 200) {
      return res.elements;
    } else {
      throw new Error(`Failed with status code: ${res.statusCode}`);
    }
  } catch (error) {
    console.error("Error processing buffer:", error);
    throw error;
  }
}
