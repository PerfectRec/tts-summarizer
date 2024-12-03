# TTS Summarizer

## Requirements

- Node.js version 20 or higher (a key library we are using does not work with anything below 20)

## Getting Started

### Server setup

- Install Node.js 20 or higher. On Linux/MacOS use `nvm`. On Windows, simply download it from the Node.js website.
- Get a copy of the **.env** file settings and put it inside the .env on the root folder
- From the root folder run `yarn` then `yarn upgrade`

- Install MAC specific libraries and helpers

```sh
arch -arm64 brew install pkg-config cairo pango libpng librsvg
```

### Website / Client Setup

- From the `client` folder run `yarn`. This will install the packages required

### Start the server

- To start the server in dev mode with Hot Module Reload (HMR), from the root folder run `yarn dev`
- Go to `http://localhost:4242`
- Upload a `pdf` or `epub` file.

## Dependencies

We are using

- `fastify` as our primary Node framework.
- `S3` to store the audio files and metadata.
- `Polly` to convert generated text to audio.
- `Anthropic` or `OpenAI` models to generate the summries.
- `Mailchimp` to send transactional and marketing emails.
- `Helicone` for logging and monitoring Claude API calls.
