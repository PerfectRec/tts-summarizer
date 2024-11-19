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
  const { email, error } = request.query;
  const runId = uuidv4();

  const receivedTime = getCurrentTimestamp();

  reply.status(200).send({
    runId: runId,
    receivedTime: receivedTime,
  });

  // Simulate status updates
  uploadStatus(
    runId,
    "Received",
    {
      message: "Request received",
      receivedTime: receivedTime,
    },
    true
  );
  console.log(`Created runStatus/${runId}.json in S3`);

  if (error && error === "1") {
    setTimeout(() => {
      const errorTime = getCurrentTimestamp();
      uploadStatus(
        runId,
        "Error",
        {
          email: email,
          errorType: "SimulatedError",
          message: "Simulated error as requested",
          receivedTime: receivedTime,
          errorTime: errorTime,
        },
        true
      );
      console.log("Simulated error status uploaded");
    }, 10000);
    return;
  }

  let startedProcessingTime: string;

  setTimeout(() => {
    startedProcessingTime = getCurrentTimestamp();
    uploadStatus(
      runId,
      "Processing",
      {
        message: "Started processing",
        uploadedFileUrl: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH.pdf`,
        receivedTime: receivedTime,
        startedProcessingTime: startedProcessingTime,
      },
      true
    );
    console.log("Processing status updated");
  }, 5000);

  let completedTime: string;

  setTimeout(() => {
    completedTime = getCurrentTimestamp();
    uploadStatus(
      runId,
      "Completed",
      {
        email: email,
        message: "Generated audio output and metadata",
        uploadedFileUrl: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH.pdf`,
        audioFileUrl: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH.mp3`,
        metadataFileUrl: `https://${process.env.AWS_BUCKET_NAME}/chandradeep@perfectrec.com/Bloom%20WFH-metadata.json`,
        extractedTitle: "Bloom Work From Home",
        receivedTime: receivedTime,
        startedProcessingTime: startedProcessingTime,
        completedTime: completedTime,
      },
      true
    );
    console.log("Completed status updated");
  }, 30000);

  // No need to return anything as the response is sent in the timeout
}
