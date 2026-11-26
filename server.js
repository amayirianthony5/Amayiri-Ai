import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/generated", express.static(path.join(__dirname, "public", "generated")));

const PORT = process.env.PORT || 3000;
const KLING_API_KEY = process.env.KLING_API_KEY;
const KLING_BASE_URL = process.env.KLING_BASE_URL || "https://api-singapore.klingai.com";
const jobs = new Map();
// DEMO ONLY: memory-based daily quota. Replace with authenticated users + persistent DB before public launch.
const dailyUsage = new Map();
const generatedDir = path.join(__dirname, "public", "generated");
await fs.mkdir(generatedDir, { recursive: true });

function dayKey() { return new Date().toISOString().slice(0, 10); }
function quotaKey(userId) { return `${dayKey()}:${userId}`; }
function splitPrompt(prompt) {
  return [
    `PART 1 OF A TWO-PART 60-SECOND FILM. Establish the characters, location and opening situation. ${prompt} Create a complete coherent first 30-second cinematic sequence. End with a visual transition or unresolved action that can continue naturally into part 2. Maintain consistent character appearance, wardrobe, props, time of day and visual style.`,
    `PART 2 OF THE SAME TWO-PART 60-SECOND FILM. Continue directly from the previous sequence. ${prompt} Create the next 30-second cinematic sequence with the same characters, facial features, wardrobe, props, location and visual treatment. Develop the action and deliver a satisfying ending. This must feel like the second half of the same film, not a new story.`
  ];
}
async function kling(pathname, options = {}) {
  const response = await fetch(`${KLING_BASE_URL}${pathname}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${KLING_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    throw new Error(data.message || `Kling API request failed (${response.status})`);
  }
  return data.data;
}
function extractVideoUrl(task) {
  const candidates = [
    ...(Array.isArray(task?.outputs) ? task.outputs.filter(x => x?.type === "video").map(x => x.url) : []),
    task?.task_result?.videos?.[0]?.url,
    task?.task_result?.video_url,
    task?.videos?.[0]?.url,
    task?.video_url,
    task?.output?.video_url
  ];
  return candidates.find(x => typeof x === "string" && x.startsWith("http"));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForKlingTask(taskId, maxMinutes = 25) {
  const deadline = Date.now() + maxMinutes * 60_000;
  while (Date.now() < deadline) {
    const response = await kling(`/tasks?task_ids=${encodeURIComponent(taskId)}`, { method: "GET" });
    const rows = Array.isArray(response) ? response : (Array.isArray(response?.result) ? response.result : []);
    const task = rows.find(x => x.id === taskId) || rows[0];
    if (task?.status === "succeeded") {
      const url = extractVideoUrl(task);
      if (!url) throw new Error("Kling finished the task but did not return a recognised video URL. Check the provider task response.");
      return url;
    }
    if (task?.status === "failed") throw new Error(task.message || "Video generation failed at the provider.");
    await sleep(15_000);
  }
  throw new Error("Video generation is taking longer than expected. Check the provider task status.");
}
async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download generated clip (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, bytes);
}
function stitch(first, second, output) {
  return new Promise((resolve, reject) => {
    const list = path.join(path.dirname(output), `concat-${crypto.randomUUID()}.txt`);
    fs.writeFile(list, `file '${first.replaceAll("'", "'\\''")}'\nfile '${second.replaceAll("'", "'\\''")}'\n`)
      .then(() => {
        const proc = spawn(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output]);
        let err = "";
        proc.stderr.on("data", d => err += d.toString());
        proc.on("close", async code => {
          await fs.rm(list, { force: true });
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg could not join the clips: ${err.slice(-1200)}`));
        });
        proc.on("error", reject);
      }).catch(reject);
  });
}
async function processJob(job) {
  try {
    job.status = "generating";
    job.message = "Creating two 30-second scenes with Kling 4.0…";
    const prompts = splitPrompt(job.prompt);
    const settings = { duration: 30, resolution: "720p", aspect_ratio: job.aspectRatio };
    const created = await Promise.all(prompts.map(prompt => kling("/text-to-video/kling-4.0", {
      method: "POST", body: JSON.stringify({ prompt, settings })
    })));
    const ids = created.map(x => x.id);
    job.providerTaskIds = ids;
    job.message = "Your two scenes are rendering. This can take several minutes.";
    const urls = await Promise.all(ids.map(id => waitForKlingTask(id)));
    const a = path.join(generatedDir, `${job.id}-part1.mp4`);
    const b = path.join(generatedDir, `${job.id}-part2.mp4`);
    const out = path.join(generatedDir, `${job.id}.mp4`);
    await Promise.all([download(urls[0], a), download(urls[1], b)]);
    job.message = "Joining both scenes into one 60-second video…";
    await stitch(a, b, out);
    await Promise.all([fs.rm(a, { force: true }), fs.rm(b, { force: true })]);
    job.status = "completed";
    job.videoUrl = `/generated/${job.id}.mp4`;
    job.message = "Your video is ready.";
  } catch (error) {
    job.status = "failed";
    job.message = error.message;
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true, providerConfigured: Boolean(KLING_API_KEY) }));
app.post("/api/videos", async (req, res) => {
  if (!KLING_API_KEY) return res.status(503).json({ error: "Video generation is not configured yet. Add KLING_API_KEY on the server." });
  const { prompt, aspectRatio, userId } = req.body || {};
  if (typeof prompt !== "string" || prompt.trim().length < 10) return res.status(400).json({ error: "Please enter a video idea of at least 10 characters." });
  if (!["16:9", "9:16"].includes(aspectRatio)) return res.status(400).json({ error: "Choose landscape (16:9) or portrait (9:16)." });
  if (typeof userId !== "string" || userId.trim().length < 8) return res.status(400).json({ error: "A signed-in user ID is required for the daily free-video limit." });
  const key = quotaKey(userId.trim());
  if ((dailyUsage.get(key) || 0) >= 1) return res.status(429).json({ error: "Your one free video for today has already been used. Please come back tomorrow." });
  dailyUsage.set(key, (dailyUsage.get(key) || 0) + 1);
  const job = { id: crypto.randomUUID(), status: "queued", message: "Your video request is queued.", prompt: prompt.trim(), aspectRatio, videoUrl: null };
  jobs.set(job.id, job);
  processJob(job);
  res.status(202).json({ id: job.id, status: job.status, message: job.message });
});
app.get("/api/videos/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Video job not found. Jobs are stored in memory in this starter build." });
  res.json({ id: job.id, status: job.status, message: job.message, videoUrl: job.videoUrl });
});
app.listen(PORT, () => console.log(`AMAYIRI AI running on http://localhost:${PORT}`));
