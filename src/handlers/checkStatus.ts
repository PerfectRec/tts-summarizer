import { FastifyRequest, FastifyReply } from "fastify";
import { getFileContent } from "@aws/s3";

interface CheckStatusRequestParams {
  runId: string;
}

export default async function handler(
  request: FastifyRequest<{
    Querystring: CheckStatusRequestParams;
  }>,
  reply: FastifyReply
) {
  const { runId } = request.query;
  const fileName = `runStatus/${runId}.json`;

  try {
    const fileContent = await getFileContent(fileName);

    if (!fileContent) {
      return reply.status(200).send({
        status: "Missing",
        message: "No such file exists",
      });
    }
    reply.status(200).send(JSON.parse(fileContent));
  } catch (error) {
    reply.status(500).send({
      status: "Corrupted",
      message: "The requested file is not properly formatted.",
    });
  }
  return;
}
