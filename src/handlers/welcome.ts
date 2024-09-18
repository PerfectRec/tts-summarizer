import { FastifyRequest, FastifyReply } from "fastify";

export default async function handler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return { message: "Welcome to the Audio Summarizer + TTS API" };
}
