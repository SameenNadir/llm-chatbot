// server.js
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import pdfParse from "pdf-parse/lib/pdf-parse.js"; // <-- safe import: no test hooks
import mammoth from "mammoth";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Storage & upload setup
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const STORAGE_FILE = path.join(process.cwd(), "storage.json");

// Load or init storage
let documents = {}; // docId -> { filename, chunks: [{text, embedding}], history: [{q,a}], createdAt }
if (fs.existsSync(STORAGE_FILE)) {
  try {
    const raw = fs.readFileSync(STORAGE_FILE, "utf-8");
    documents = JSON.parse(raw) || {};
    console.log(`📂 Loaded ${Object.keys(documents).length} docs from storage.json`);
  } catch (err) {
    console.error("⚠️ Failed to parse storage.json - starting empty:", err);
    documents = {};
  }
}
function saveDocuments() {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(documents, null, 2));
}

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// Gemini / Google Generative AI setup
if (!process.env.GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY not set in .env — API calls will fail until set.");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Choose models (change if your account supports newer / different models)
const EMBED_MODEL_ID = process.env.EMBED_MODEL || "embedding-001";
const CHAT_MODEL_ID = process.env.CHAT_MODEL || "gemini-1.5-flash";

// Helper to get model objects
function getEmbedModel() {
  return genAI.getGenerativeModel({ model: EMBED_MODEL_ID });
}
function getChatModel() {
  return genAI.getGenerativeModel({ model: CHAT_MODEL_ID });
}

// Helpers: extractors
async function extractPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parsed = await pdfParse(buffer);
  return parsed.text || "";
}
async function extractDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || "";
}

// Chunking
function chunkText(text, chunkSize = 800, overlap = 200) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += chunkSize - overlap;
  }
  return chunks;
}

// Embedding helpers
async function embedText(text) {
  // embedModel.embedContent(text) returns an object depending on SDK version;
  // We attempt common access patterns used in SDKs:
  const embedModel = getEmbedModel();
  const response = await embedModel.embedContent(text);
  // try to extract vector robustly:
  if (response?.embedding?.values) return response.embedding.values;
  if (response?.data?.[0]?.embedding) return response.data[0].embedding;
  if (response?.embeddings?.[0]?.values) return response.embeddings[0].values;
  throw new Error("Unexpected embedding response shape: " + JSON.stringify(response).slice(0, 200));
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((s, ai, i) => s + ai * b[i], 0);
  const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}

// Routes

// Upload and process document: extract -> chunk -> embed -> persist
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    let text = "";

    if (ext === ".pdf") text = await extractPdf(filePath);
    else if (ext === ".docx" || ext === ".doc") text = await extractDocx(filePath);
    else if (ext === ".txt") text = fs.readFileSync(filePath, "utf-8");
    else {
      fs.unlinkSync(filePath);
      return res.status(400).json({ success: false, error: "Unsupported file type" });
    }

    // clean up uploaded raw file
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }

    const rawChunks = chunkText(text);
    const embeddedChunks = [];

    // embed in sequence (you may parallelize, but sequential is simpler and safer re: rate limits)
    for (const c of rawChunks) {
      const vec = await embedText(c);
      embeddedChunks.push({ text: c, embedding: vec });
    }

    const docId = Date.now().toString();
    documents[docId] = {
      filename: req.file.originalname,
      chunks: embeddedChunks,
      history: [], // { q, a, createdAt }
      createdAt: Date.now(),
    };
    saveDocuments();

    return res.json({
      success: true,
      docId,
      filename: req.file.originalname,
      chunksCount: embeddedChunks.length,
    });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ success: false, error: "Upload failed", detail: String(err) });
  }
});

// list docs (for frontend to restore last doc)
app.get("/documents", (req, res) => {
  const docs = Object.entries(documents).map(([docId, d]) => ({
    docId,
    filename: d.filename,
    chunksCount: d.chunks.length,
    historyCount: d.history.length,
    createdAt: d.createdAt,
  }));
  res.json({ success: true, docs });
});

// Ask: semantic search + LLM answer + save history
app.post("/ask", async (req, res) => {
  try {
    const { question, docId } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ success: false, error: "No question provided" });
    if (!docId || !documents[docId]) return res.status(400).json({ success: false, error: "Invalid or missing docId" });

    const doc = documents[docId];
    const chunks = doc.chunks;

    // embed question
    const qVec = await embedText(question);

    // score chunks by similarity
    const scored = chunks.map(c => ({
      text: c.text,
      score: cosineSimilarity(qVec, c.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);

    // pick top N chunks as context (balance tokens vs relevance)
    const TOP_K = 4;
    const topChunks = scored.slice(0, TOP_K).map(s => s.text).join("\n\n---\n\n");

    // incorporate recent history (if any) to preserve chat continuity
    const recentHistory = (doc.history || []).slice(-6).map((h, i) => `Q: ${h.q}\nA: ${h.a}`).join("\n\n");

    const prompt = `
You are a helpful assistant. Answer the user's question using ONLY the provided document content and any previous short Q&A history. If the answer isn't in the document, say you don't know and suggest where to look.

Document excerpts (most relevant first):
${topChunks}

Previous short Q&A history (if any):
${recentHistory || "None"}

User question:
${question}

Answer concisely and clearly. If you cite parts of the document, indicate short quotes or paraphrases and include no invented facts.
`;

    // call Gemini
    const chatModel = getChatModel();
    const genResult = await chatModel.generateContent(prompt);
    const rawAnswer = (() => {
      try {
        // expected accessor from earlier SDK usage
        if (genResult?.response?.text) return genResult.response.text();
        if (typeof genResult === "string") return genResult;
        if (genResult?.output?.[0]?.content?.[0]?.text) return genResult.output[0].content[0].text;
        // fallback stringify
        return JSON.stringify(genResult).slice(0, 2000);
      } catch (e) {
        return String(genResult);
      }
    })();

    // save history
    const entry = { q: question, a: rawAnswer, createdAt: Date.now() };
    doc.history.push(entry);
    saveDocuments();

    return res.json({ success: true, answer: rawAnswer, history: doc.history });
  } catch (err) {
    console.error("Ask error:", err);
    return res.status(500).json({ success: false, error: "Q&A failed", detail: String(err) });
  }
});

app.listen(PORT, () => console.log(`✅ Backend running with Gemini RAG on http://localhost:${PORT}`));
