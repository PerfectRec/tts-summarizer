import { FastifyRequest, FastifyReply } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { uploadStatus } from "@aws/s3";
import "dotenv/config";
import { getCurrentTimestamp } from "@utils/io";

export default async function mockHandler(
  request: FastifyRequest<{
    Querystring: SummarizeRequestParams;
  }>,
  reply: FastifyReply
) {
  const { email } = request.query;
  const runId = uuidv4();

  const receivedTime = getCurrentTimestamp();

  reply.status(200).send({
    runId: runId,
    receivedTime: receivedTime,
  });

  // Simulate status updates
  uploadStatus(runId, "Received", {
    message: "Request received",
    receivedTime: receivedTime,
  });
  console.log(`Created runStatus/${runId}.json in S3`);

  let startedProcessingTime: string;

  setTimeout(() => {
    startedProcessingTime = getCurrentTimestamp();
    uploadStatus(runId, "Processing", {
      message: "Started processing",
      uploadedFileUrl: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH.pdf`,
      receivedTime: receivedTime,
      startedProcessingTime: startedProcessingTime,
    });
    console.log("Processing status updated");
  }, 5000);

  let completedTime: string;

  setTimeout(() => {
    completedTime = getCurrentTimestamp();
    uploadStatus(runId, "Completed", {
      message: "Generated audio output and metadata",
      uploadedFileUrl: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH.pdf`,
      audioFileUrl: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH.mp3`,
      metadataFileUrl: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH-metadata.json`,
      extractedTitle: "Bloom Work From Home",
      receivedTime: receivedTime,
      startedProcessingTime: startedProcessingTime,
      completedTime: completedTime,
    });
    console.log("Completed status updated");
  }, 30000);

  // No need to return anything as the response is sent in the timeout
}
