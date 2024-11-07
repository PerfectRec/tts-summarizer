import { FastifyRequest, FastifyReply } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { uploadStatus } from "@aws/s3";
import "dotenv/config";

export default async function mockHandler(
  request: FastifyRequest<{
    Querystring: SummarizeRequestParams;
  }>,
  reply: FastifyReply
) {
  const { email } = request.query;
  const runId = uuidv4();

  reply.status(200).send({
    runId: runId,
  });

  // Simulate status updates
  uploadStatus(runId, "Received", { message: "Request received" });
  console.log(`Created runStatus/${runId}.json in S3`);

  setTimeout(() => {
    uploadStatus(runId, "Processing", {
      message: "Started processing",
      uploadedFileUrl: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH.pdf`,
    });
    console.log("Processing status updated");
  }, 60000); // 1 minute

  setTimeout(() => {
    uploadStatus(runId, "Completed", {
      message: "Generated audio output and metadata",
      uploadedFileUrl: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH.pdf`,
      audioFileUrl: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH.mp3`,
      metadataFile: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH-metadata.json`,
      extractedTitle: "Bloom Work From Home",
    });
    console.log("Completed status updated");
  }, 120000); // 2 minutes

  // No need to return anything as the response is sent in the timeout
}
