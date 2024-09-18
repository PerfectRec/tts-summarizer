## Requirements

- Node.js version 20 or higher
- Install packages with `yarn`

## Starting the Server

To start the server, run:

`yarn start`

To start the server in dev mode with HMR:

`yarn dev`

The server will listen on port `4242`.

## Handlers

Place API route handlers in the `src/handlers` directory, each handler in its own file.

## Architecture

We are using `S3`

- to store the user uploaded files
- to store the AI generated audio files
- to store the user interaction memory
