import { uploadFile } from "@aws/s3";
import { FastifyRequest, FastifyReply } from "fastify";

interface SyncPapersRequestParams {
  email: string;
}

export default async function handler(
  request: FastifyRequest<{
    Querystring: SyncPapersRequestParams;
  }>,
  reply: FastifyReply
) {
  const { email } = request.query;
  const papers = JSON.parse(request.body as string);

  if (!email) {
    return reply.status(400).send({
      status: "Error",
      errorType: "InvalidInput",
      message: "Email is required.",
    });
  }

  if (!papers) {
    return reply.status(400).send({
      status: "Error",
      errorType: "InvalidInput",
      message: "Papers are required.",
    });
  }

  try {
    const filePath = `userData/${email}/papers.json`;
    const fileContent = Buffer.from(JSON.stringify(papers));
    await uploadFile(fileContent, filePath);

    reply.status(200).send({
      status: "Success",
      message: "Papers synchronized successfully.",
    });
  } catch (error) {
    reply.status(500).send({
      status: "Error",
      errorType: "ProcessingError",
      message: "An error occurred while syncing the papers.",
    });
  }
  return;
}
