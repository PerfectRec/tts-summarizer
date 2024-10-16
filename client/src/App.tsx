import { useEffect, useState } from "react";
import "./App.css";

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [email, setEmail] = useState<string>("");

  const handleEmailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
  };
  // const [summarizationMethod, setSummarizationMethod] =
  //   useState<string>("ultimate");
  const summarizationMethod = "ultimate";
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      setFile(event.target.files[0]);
    }
  };

  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // const handleMethodChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
  //   setSummarizationMethod(event.target.value);
  // };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) return;

    setAudioUrl(null);
    setLoadingMessage("Improving abstract...");

    const fileBuffer = await file.arrayBuffer();

    try {
      const response = await fetch(
        `/summarize?summarizationMethod=${summarizationMethod}&&email=${email}`,
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
        setLoadingMessage("Request successful!");
      } else {
        console.error("Error:", response.statusText);
        setLoadingMessage(null);
      }
    } catch (error) {
      console.error("Error:", error);
      setLoadingMessage(null);
    }
  };

  useEffect(() => {
    if (loadingMessage === "Improving abstract...") {
      const timer1 = setTimeout(() => {
        setLoadingMessage("Processing images and tables...");
      }, 3000);
      const timer2 = setTimeout(() => {
        setLoadingMessage("Converting text to speech...");
      }, 15000);
      return () => {
        clearTimeout(timer1);
        clearTimeout(timer2);
      };
    }
  }, [loadingMessage]);

  return (
    <>
      <h1 className="text-2xl font-bold mb-4">Text-to-speech Summarizer</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <input
          type="file"
          accept=".pdf,.epub"
          onChange={handleFileChange}
          className="p-2 border rounded"
        />
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
          Upload + Summarize
        </button>
      </form>
      {loadingMessage && (
        <p className="mt-4 text-lg text-white">{loadingMessage}</p>
      )}
      {audioUrl && (
        <div className="mt-4">
          <audio
            controls
            src={audioUrl}
            className="w-full mb-2 rounded"
          ></audio>
          <a
            href={audioUrl}
            download="summary.mp3"
            className="p-2 mt-2 bg-green-500 hover:bg-green-700 text-white rounded"
          >
            Download MP3
          </a>
        </div>
      )}
    </>
  );
}

export default App;
