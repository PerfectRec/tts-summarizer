import { useState } from "react";
import "./App.css";

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
    setSubmitMessage("You're done!  Check your email in a few mins.");

    const fileBuffer = await file.arrayBuffer();
    const fileName = await file.name;

    try {
      const response = await fetch(
        `/summarize?summarizationMethod=${summarizationMethod}&email=${email}&fileName=${fileName}`,
        {
          method: "POST",
          headers: {
            "Content-Type": file.type,
          },
          body: fileBuffer,
        }
      );

      if (response.ok) {
        // Update: Display success message instead of handling audio URL
        console.log("Request successful");
        setSubmitMessage("Generate audio");
      } else {
        console.error("Error:", response.statusText);
        setSubmitMessage("Generate audio");
      }
    } catch (error) {
      console.error("Error:", error);
      setSubmitMessage("Generate audio");
    }
  };

  return (
    <div className="max-w-lg mx-auto p-4">
      <h1 className="text-4xl font-bold mb-4">paper2audio</h1>
      <div className="mb-4 text-sm">
        paper2audio creates an audio version of your research paper PDF. It
        narrates all the text of the paper, plus AI-generated summaries of any
        tables, figures, math or code.
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
        <button
          type="submit"
          className="p-2 bg-blue-500 text-white rounded hover:bg-blue-700"
        >
          {submitMessage}
        </button>
        {errorMessage && (
          <div className="text-sm text-red-500">{errorMessage}</div>
        )}
        <div className="text-sm text-red-500">
          This is a new project that we’re actively improving. The audio output
          is generally good, but not perfect. Math heavy papers unfortunately do
          not naturally translate well to audio. AI-generated summaries may not
          be 100% accurate.
        </div>
      </form>
    </div>
  );
}

export default App;
