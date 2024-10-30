import { useState } from "react";
import "./App.css";
import r2 from "./assets/r2.jpeg";

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [email, setEmail] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const handleEmailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
  };
  // const [summarizationMethod, setSummarizationMethod] =
  //   useState<string>("ultimate");
  const summarizationMethod = "ultimate";
  const [submitMessage, setSubmitMessage] = useState<string>("Generate audio");

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      setFile(event.target.files[0]);
      setSubmitMessage("Generate audio");
    }
  };

  // const handleMethodChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
  //   setSummarizationMethod(event.target.value);
  // };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || !email || email === "") {
      setErrorMessage("Please select a file and enter your email address.");
      return;
    }

    setErrorMessage("");
    setSubmitMessage(
      "You're done! Check your inbox (and spam folder) in a few mins."
    );

    const fileBuffer = await file.arrayBuffer();
    const fileName = file.name;

    try {
      fetch(
        `/summarize?summarizationMethod=${summarizationMethod}&email=${email}&fileName=${fileName}`,
        {
          method: "POST",
          headers: {
            "Content-Type": file.type,
          },
          body: fileBuffer,
        }
      );
    } catch (error) {
      setSubmitMessage("Generate audio");
    }
  };

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-5xl font-bold my-4">paper2audio</h1>
      <div className="mb-4 text-sm">
        paper2audio creates an audio version of your research paper PDF. It
        narrates all the text of the paper without summarizing it, plus
        AI-generated summaries of any tables, figures, or code.
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <input
          type="file"
          accept=".pdf"
          onChange={handleFileChange}
          className="p-2 border rounded"
        />
        <div className="text-sm">
          Audio generation takes a few minutes. We'll email you a link to the
          file when it is ready.
        </div>
        <input
          type="email"
          value={email}
          onChange={handleEmailChange}
          placeholder="Enter your email"
          className="p-2 border rounded"
        />
        {/* <select
          value={summarizationMethod}
          onChange={handleMethodChange}
          className="p-2 border rounded"
        >
          <option value="betterAbstract">Better Abstract</option>
          <option value="twoPage">Two-page Summary</option>
          <option value="chaptered">Chaptered Summary</option>
          <option value="tablesAndFiguresOnly">Tables and Figures Only</option>
          <option value="ultimate">
            Better Abstract + Tables and Figures Only
          </option>
        </select> */}
        <div className="text-sm">
          This is a new project that we’re actively improving. The audio output
          is generally good, but not perfect. AI-generated summaries may not be
          100% accurate.
        </div>
        <button
          type="submit"
          className="p-2 bg-blue-500 text-white rounded hover:bg-blue-700"
        >
          {submitMessage}
        </button>
        {errorMessage && errorMessage !== "" && (
          <div className="text-sm text-red-500">{errorMessage}</div>
        )}
        <div className="text-sm">
          We don't currently support processing complex math notation. We will
          attempt to read math to you, but it may be too difficult to understand
          it via audio, and maybe have some inaccuracies. We are actively
          working on these issues.
        </div>
      </form>
      <div className="mt-16">
        <h2 className="text-2xl font-bold mb-2">About</h2>
        <p className="">
          paper2audio is a new project recently started by
          <a
            href="https://www.linkedin.com/in/jgolden9/"
            className="text-blue-500"
          >
            {" "}
            Joe Golden
          </a>{" "}
          and
          <a
            href="https://www.linkedin.com/in/chandradeepc/"
            className="text-blue-500"
          >
            {" "}
            Chandradeep Chowdhury
          </a>
          . Its goal: completely or partially replace reading a research paper.
        </p>
        <h3 className="text-xl font-bold mt-8 mb-2">Some use cases:</h3>
        <ul className="list-disc list-outside text-left ml-4 space-y-2">
          <li>
            You never get to the bottom of your stack of research papers to
            read. Listen to them instead.
          </li>
          <li>
            You have a paper to review. Listen to it first, then review it more
            quickly and easily.
          </li>
          <li>
            You find it hard to stay focused on reading research papers. Listen
            instead.
          </li>
        </ul>
        <h3 className="text-xl font-bold mt-8">How to listen to a paper</h3>
        <p className="mt-2">
          We recommend{" "}
          <a href="https://www.videolan.org/" className="text-blue-500">
            {" "}
            VLC Media Player
          </a>
          , which is free, open-source and cross-platform.{" "}
          <a
            href="https://apps.apple.com/us/app/vlc-media-player/id650377962"
            className="text-blue-500"
          >
            {" "}
            iOS
          </a>{" "}
          <a
            href="https://play.google.com/store/apps/details?id=org.videolan.vlc&hl=en_US"
            className="text-blue-500"
          >
            {" "}
            Android
          </a>
        </p>
        <h3 className="text-xl font-bold mt-8 mb-2">
          Joe’s advice for listening
        </h3>
        <ul className="list-disc list-outside ml-4 text-left space-y-2">
          <li>
            Find your optimal playback speed overall. 1.5-2x or possibly even
            higher may be best for you. Too slow of a speed may be boring for
            you and make it hard to pay attention. A faster speed helps you
            listen to more papers.
          </li>
          <li>
            Adjust your speed for some papers or sections. You might need to
            slow down to understand dense information or for information you
            need to understand very well. Conversely, you might like to speed up
            for less dense or critical information.
          </li>
          <li>
            Consider listening to important papers or parts of papers a second
            time.
          </li>
          <li>
            Try slowing increasing your default playback speed over time as you
            get more experienced and used to listening to papers.
          </li>
          <li>
            Listen when doing things that require your time, but not your full
            attention. Here are some good activities that support listening:
            driving, doing dishes or laundry, cleaning, walking, traveling,
            exercising, getting dressed, brushing your teeth and yard work.
          </li>
        </ul>
        <h3 className="text-xl font-bold mt-8 mb-2">
          Next steps for paper2audio
        </h3>
        <ul className="list-disc list-outside ml-4 text-left space-y-2">
          <li>Improve various aspects of audio output</li>
          <li>
            Add some customization options (while keeping a focus on optimizing
            the default output)
          </li>
          <li>Improvements and features requested by users</li>
          <li>Building a phone app with integrated playback</li>
        </ul>
        <h3 className="text-xl font-bold mt-8 mb-2">
          Some issues we’ve already addressed
        </h3>
        <ul className="list-disc list-outside ml-4 text-left space-y-2">
          <li>Added 2 column paper support</li>
          <li>
            Implemented detecting and removing meta information before the
            abstract including journal logos
          </li>
          <li>
            Cleaning up and rewriting author info which is formatted poorly for
            text to speech
          </li>
          <li>
            Repositioning tables and figures near their first mention for better
            audio flow
          </li>
          <li>
            Getting rid of meta info throughout the paper like page numbers,
            disclaimers, and table of contents
          </li>
        </ul>
        <h3 className="text-xl font-bold mt-8">
          Our Sci-Fi Inspiration from The Matrix
        </h3>
        <iframe
          className="w-full aspect-video mt-4"
          src="https://www.youtube.com/embed/w_8NsPQBdV0"
          title="YouTube video player"
          frameBorder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        ></iframe>
        <h3 className="text-xl font-bold mt-8">Personal note from Joe</h3>
        <p className="text-left mt-2">
          I’m a 39 year old economics PhD and entrepreneur. I’ve always had too
          much to read since I was a teenager. I often find it hard to focus
          when sitting down to read, but I also get insanely bored doing chores
          and other low attention activities. For me, listening kills two birds
          with one stone.
        </p>
        <p className="text-left mt-4">
          Like many people, I’ve naturally gravitated towards audiobooks and
          podcasts. More unusually, for about a decade, I’ve saved news articles
          to an app, and used text-to-speech to listen to them. That’s how over
          time I’ve developed the above advice for listening. Before that, my
          browser tabs from news sites would continually pile up, forcing me to
          cyclically declare tab bankruptcy.
        </p>
        <p className="text-left mt-4">
          But, until recent advances in generative AI, the underlying technology
          didn’t exist to be able to listen to research papers that include
          non-text content like tables and figures. So, despite my interest, due
          to a scarcity of both time and attention, I’ve struggled to read as
          many papers as I would like. So, I started paper2audio to solve this
          problem for myself, and I’m hoping lots of other people who similarly
          would be interested in listening to research papers.
        </p>
        <h3 className="text-xl font-bold mt-8">We Want Your Feedback</h3>
        <p className="text-left mt-2">
          We’ll use it to make paper2audio a better service! Please share
          feedback:
          <a href="mailto:Joe@paper2audio.com" className="text-blue-500">
            {" "}
            Joe@paper2audio.com
          </a>
          . Be critical and channel your inner R2:
        </p>
        <img src={r2} alt="R2 meme graphic" className="my-8" />
      </div>
    </div>
  );
}

export default App;
