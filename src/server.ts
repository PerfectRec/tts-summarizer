// Import the framework and instantiate it
import Fastify from "fastify";
// Handler imports
import welcomeHandler from "./handlers/welcome";
import summarizeHandler from "./handlers/summarize";

const fastify = Fastify({
  logger: true,
});

// Routes
fastify.get("/", welcomeHandler);
fastify.post("/summarize", summarizeHandler);

// Run the server!
try {
  await fastify.listen({ port: 4242 });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
