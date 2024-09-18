import { FastifyRequest, FastifyReply } from "fastify";

interface SummarizeRequestParams {
  summarizationMethod:
    | "betterAbstract"
    | "twoPage"
    | "chaptered"
    | "tablesAndFiguresOnly";
}

export default async function handler(
  request: FastifyRequest<{
    Querystring: SummarizeRequestParams;
  }>,
  reply: FastifyReply
) {
  const { summarizationMethod } = request.query;
  const file = request.body;

  console.log(file)

  return { message: "Processed file" };
}
