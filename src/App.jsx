import { useState, useEffect, useRef } from "react";
import axios from "axios";
import { Send, Upload, Plus } from "lucide-react";

const LOCAL_STORAGE_KEY = "llm_chat_app_v4";

export default function App() {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [input, setInput] = useState("");
  const [file, setFile] = useState(null);
  const [uploadedDocId, setUploadedDocId] = useState(null);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(""); // ✅ popup state
  const chatEndRef = useRef(null);

  // Toast helper
  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000); // hide after 3s
  }

  // Load
  useEffect(() => {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      setChats(data.chats || []);
      setActiveChatId(data.activeChatId || null);
      setUploadedDocId(data.uploadedDocId || null);
      setUploadedFileName(data.uploadedFileName || "");
    } else {
      const id = Date.now().toString();
      const welcomeChat = {
        id,
        title: "Welcome",
        messages: [{ sender: "bot", text: "👋 Upload a document to start." }],
        createdAt: Date.now(),
      };
      setChats([welcomeChat]);
      setActiveChatId(id);
    }
  }, []);

  // Save
  useEffect(() => {
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({ chats, activeChatId, uploadedDocId, uploadedFileName })
    );
  }, [chats, activeChatId, uploadedDocId, uploadedFileName]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chats]);

  const activeChat = chats.find((c) => c.id === activeChatId);

  function appendMessage(msg) {
    setChats((prev) =>
      prev.map((c) =>
        c.id === activeChatId ? { ...c, messages: [...c.messages, msg] } : c
      )
    );
  }

  async function uploadFile() {
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);

    // ✅ Show popup while uploading
    showToast(`⏳ Uploading "${file.name}"...`);

    try {
      const res = await axios.post("http://localhost:5000/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setUploadedDocId(res.data.docId);
      setUploadedFileName(file.name);

      appendMessage({
        sender: "bot",
        text: `✅ File "${file.name}" uploaded (${res.data.chunksCount} chunks).`,
      });

      showToast(`✅ File "${file.name}" uploaded successfully!`);
      setFile(null);
    } catch (err) {
      console.error(err);
      appendMessage({ sender: "bot", text: "⚠️ Upload failed." });
      showToast("❌ Upload failed!");
    }
  }

  async function sendQuestion() {
    if (!input.trim()) return;
    if (!uploadedDocId) {
      appendMessage({ sender: "bot", text: "⚠️ Upload a document first!" });
      showToast("⚠️ Please upload a document first!");
      return;
    }

    appendMessage({ sender: "user", text: input });
    const q = input;
    setInput("");
    setLoading(true);
    showToast("🤔 Sending your question...");
    try {
      const res = await axios.post("http://localhost:5000/ask", {
        question: q,
        docId: uploadedDocId,
      });
      appendMessage({ sender: "bot", text: res.data.answer });
      showToast("✅ Answer received!");
    } catch (err) {
      console.error(err);
      appendMessage({ sender: "bot", text: "⚠️ Error asking question." });
      showToast("❌ Error asking question!");
    } finally {
      setLoading(false);
    }
  }

  function createNewChat() {
    const id = Date.now().toString();
    const newChat = {
      id,
      title: "New Chat",
      messages: [{ sender: "bot", text: "✨ New chat started." }],
      createdAt: Date.now(),
    };
    setChats((prev) => [newChat, ...prev]);
    setActiveChatId(id);
  }

  const backgroundImageUrl =
    "https://images.unsplash.com/photo-1626503536928-7598ca5b2ce8?q=80&w=1631&auto=format&fit=crop";

  return (
    <div
      className="h-screen w-screen flex relative text-white"
      style={{
        backgroundImage: `url(${backgroundImageUrl})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-black/40" />

      {/* SIDEBAR */}
      <aside className="w-64 bg-purple-900/90 backdrop-blur-md p-4 flex flex-col z-10">
        <h2 className="text-lg font-bold mb-4">Chats</h2>
        <button
          onClick={createNewChat}
          className="mb-4 bg-purple-600 hover:bg-purple-700 text-white px-3 py-2 rounded-lg flex items-center gap-2 shadow"
        >
          <Plus size={16} /> New Chat
        </button>

        <div className="flex-1 overflow-y-auto space-y-2">
          {chats.map((c) => (
            <div
              key={c.id}
              onClick={() => setActiveChatId(c.id)}
              className={`p-3 rounded-lg cursor-pointer ${
                c.id === activeChatId
                  ? "bg-purple-500 text-white"
                  : "bg-purple-800/50 hover:bg-purple-700"
              }`}
            >
              {c.title}
            </div>
          ))}
        </div>

        {/* File Upload */}
        <div className="mt-4 p-3 bg-purple-800/60 rounded-lg">
          <input
            type="file"
            accept=".pdf,.docx,.txt"
            onChange={(e) => setFile(e.target.files[0])}
            className="mb-2 w-full text-sm"
          />
          <button
            onClick={uploadFile}
            disabled={!file}
            className="w-full bg-purple-600 text-white py-2 rounded-lg flex items-center justify-center gap-2 disabled:bg-gray-400"
          >
            <Upload size={14} /> Upload
          </button>
        </div>
      </aside>

      {/* CHAT AREA */}
      <main className="flex-1 flex flex-col relative z-10">
        <div className="p-4 border-b border-white/20 bg-purple-950/70 text-lg font-bold">
          📄 LLM Doc Chatbot
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {activeChat?.messages.map((m, i) => (
            <div
              key={i}
              className={`flex ${
                m.sender === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`px-4 py-2 rounded-2xl max-w-lg shadow ${
                  m.sender === "user"
                    ? "bg-purple-600 text-white"
                    : "bg-gray-200 text-black"
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        {/* Input */}
        <div className="p-4 bg-purple-950/80 flex gap-3 border-t border-white/20">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              uploadedDocId ? "Ask a question..." : "Upload a doc first..."
            }
            className="flex-1 px-4 py-2 rounded-full bg-gray-100 text-black focus:outline-none"
            onKeyDown={(e) => e.key === "Enter" && sendQuestion()}
            disabled={loading}
          />
          <button
            onClick={sendQuestion}
            disabled={!input.trim() || loading}
            className="px-5 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-full flex items-center gap-2 shadow disabled:bg-gray-400"
          >
            {loading ? "..." : <><Send size={16} /> Send</>}
          </button>
        </div>
      </main>

    {/* ✅ Toast Notification */}
{toast && (
  <div className="fixed top-5 left-1/2 transform -translate-x-1/2 bg-black/90 text-white px-6 py-3 rounded-lg shadow-lg z-50">
    {toast}
  </div>
)}

    </div>
  );
}
