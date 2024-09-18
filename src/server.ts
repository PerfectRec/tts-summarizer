// Import the framework and instantiate it
import Fastify from "fastify";
// Handler imports
import welcomeHandler from "./handlers/welcome";

const fastify = Fastify({
  logger: true,
});

// Declare a route
fastify.get("/", welcomeHandler);

// Run the server!
try {
  await fastify.listen({ port: 4242 });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
