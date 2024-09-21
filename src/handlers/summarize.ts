import { FastifyRequest, FastifyReply } from "fastify";
import { LlamaParseReader } from "llamaindex";
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
  const documents = await reader.loadJson(tempFilePath);
  const images = await reader.getImages(documents, tempImageDir);

  // Clean up the temporary file
  //await fs.remove(tempFilePath);

  return { message: "Processed file", documents, images };
}
