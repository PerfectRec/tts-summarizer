import { getFileContent } from "@aws/s3";
import { FastifyRequest, FastifyReply } from "fastify";

interface GetPapersRequestParams {
  email: string;
}

export default async function handler(
  request: FastifyRequest<{
    Querystring: GetPapersRequestParams;
  }>,
  reply: FastifyReply
) {
  const { email } = request.query;

  if (!email) {
    return reply.status(400).send({
      status: "Error",
      errorType: "InvalidInput",
      message: "Email is required.",
    });
  }

  try {
    const filePath = `userData/${email}/papers.json`;
    const fileContent = await getFileContent(filePath);

    if (!fileContent) {
      return reply.status(404).send({
        status: "Error",
        errorType: "NotFound",
        message: "No papers found for the given email.",
      });
    }

    reply.status(200).send({
      status: "Success",
      papers: JSON.parse(fileContent),
    });
  } catch (error) {
    reply.status(500).send({
      status: "Error",
      errorType: "ProcessingError",
      message: "An error occurred while fetching the papers.",
    });
  }
  return;
}
