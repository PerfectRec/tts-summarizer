// Import the framework and instantiate it
import Fastify from "fastify";
// Handler imports
import summarizeHandler from "@handlers/summarize";

const fastify = Fastify({
  logger: true,
});

// Add content type parsers
fastify.addContentTypeParser('application/pdf', { parseAs: 'buffer' }, (req, body, done) => {
  done(null, body);
});

// Routes
fastify.post("/summarize", summarizeHandler);

// Run the server!
try {
  await fastify.listen({ port: 4242 });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
