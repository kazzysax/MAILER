import { config } from "./config.js";

export const voiceEnabled = () => !!config.openaiKey;

/* ---------- shared transcription core (any audio buffer) ---------- */
export async function transcribeBuffer(audio, contentType) {
  if (!voiceEnabled()) throw new Error("Transcription not enabled on this server.");
  const ext = (contentType || "").includes("ogg") ? "ogg" : (contentType || "").includes("mp4") ? "m4a" : "mp3";

  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentType || "audio/ogg" }), `voice.${ext}`);
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Transcription failed: ${res.status} ${(await res.text()).slice(0, 150)}`);
  const data = await res.json();
  return (data.text || "").trim();
}

/* ---------- WhatsApp (Twilio media needs basic auth) ---------- */
async function downloadTwilioMedia(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${config.twilio.sid}:${config.twilio.token}`).toString("base64"),
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function transcribeVoiceNote(mediaUrl, contentType) {
  const audio = await downloadTwilioMedia(mediaUrl);
  return transcribeBuffer(audio, contentType);
}

/* ---------- Telegram (file link needs no extra auth) ---------- */
export async function transcribeTelegramVoice(fileUrl) {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
  const audio = Buffer.from(await res.arrayBuffer());
  return transcribeBuffer(audio, "audio/ogg"); // Telegram voice notes are OGG/Opus
}
