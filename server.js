import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";
import sdk from "microsoft-cognitiveservices-speech-sdk";

// Configuration (Replace with your own environment variables)
const app = express();
const PORT = process.env.PORT || 8081;
const KEY = process.env.AZURE_SPEECH_KEY;
const REGION = process.env.AZURE_SPEECH_REGION || process.env.AZURE_REGION; // fallback
const N8N = process.env.N8N_WEBHOOK_URL || process.env.N8N_WEBHOOK || "";

if (!KEY || !REGION) {
  console.error("Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION env vars.");
  process.exit(1);
}

// μ-law to PCM16 decoder function
function decodeMuLawToPCM16(mulawData) {
  const pcm16 = new Int16Array(mulawData.length);
  for (let i = 0; i < mulawData.length; i++) {
    let mulaw = mulawData[i];
    mulaw = ~mulaw;
    let t = ((mulaw & 0xF) << 3) + 0x84;
    t <<= (mulaw & 0x70) >> 4;
    pcm16[i] = mulaw & 0x80 ? (0x84 - t) : (t - 0x84);
  }
  return pcm16;
}

// Health check route
app.get("/health", (_req, res) => res.send("ok"));

// Function to generate TwiML response for Twilio
function voiceTwiml(hostname) {
  const wsUrl = `wss://${hostname}/twilio`;  // WebSocket URL to handle incoming audio
  const twiml = `<Response>
    <Say voice="Polly.Matthew">Hi! My name is Gio from Trend Micro Support. How can I assist you today?</Say>
    <Start><Stream url="${wsUrl}" track="inbound"/></Start>
    <Pause length="60"/>
  </Response>`;

  console.log("Generated TwiML: ", twiml);  // Log the generated TwiML for debugging
  return twiml;
}

// Twilio Voice Webhook Route
app.post("/voice", express.urlencoded({ extended: false }), (req, res) => {
  console.log("Twilio Webhook Triggered, Request Body: ", req.body); // Log the request body
  res.type("text/xml").send(voiceTwiml(req.headers.host));  // Return TwiML to Twilio
});

// WebSocket server to handle incoming audio streams from Twilio
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (ws) => {
  console.log("Twilio WebSocket connected");
  let callSid = "";
  let rec;           // Speech Recognizer from Azure
  let pushStream;    // SDK PushAudioInputStream for Azure STT
  let lastSentTime = 0; // Debouncing timestamp

  const startRecognizer = () => {
    const cfg = sdk.SpeechConfig.fromSubscription(KEY, REGION);
    cfg.speechRecognitionLanguage = "en-US";  // Language of STT

    const fmt = sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1);
    pushStream = sdk.AudioInputStream.createPushStream(fmt);
    const audio = sdk.AudioConfig.fromStreamInput(pushStream);
    rec = new sdk.SpeechRecognizer(cfg, audio);

    // Interim (partial) results from Azure STT
    rec.recognizing = async (_s, e) => {
      if (e.result?.text) {
        console.log("[STT:interim]", e.result.text);  // Log interim transcription
        // Don't send interim results to n8n to prevent multiple executions
      }
    };

    // Final results from Azure STT
    rec.recognized = async (_s, e) => {
      if (e.result?.text) {
        console.log("[STT:final]", e.result.text);  // Log final transcription

        // Debouncing: prevent sending requests too frequently
        const now = Date.now();
        if (now - lastSentTime < 2000) { // 2 second minimum between requests
          console.log("Debouncing: skipping request (too soon)");
          return;
        }
        lastSentTime = now;

        // Send final result to n8n
        if (N8N) {
          try {
            await fetch(N8N, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                callSid,
                text: e.result.text,
                timestamp: new Date().toISOString(),
              })
            });
          } catch (err) {
            console.error("Error posting final to n8n:", err.message);
          }
        }
      }
    };

    // Handle recognizer errors
    rec.canceled = (_s, e) => {
      console.warn("Recognizer canceled:", e?.errorDetails || e?.reason);
    };

    // Handle session stopped
    rec.sessionStopped = () => {
      console.log("Recognizer session stopped");
    };

    // Start speech recognition
    rec.startContinuousRecognitionAsync(
      () => console.log("Recognizer started"),
      (err) => console.error("Recognizer start error:", err?.message || err)
    );
  };

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (data.event) {
      case "start":
        callSid = data.start?.callSid || "";
        console.log("Stream started:", callSid);
        startRecognizer();
        break;

      case "media": {
        if (!pushStream || !data.media?.payload) return;
        const ulaw = Buffer.from(data.media.payload, "base64");
        const pcm16 = decodeMuLawToPCM16(ulaw);
        const buf = Buffer.allocUnsafe(pcm16.length * 2);
        for (let i = 0; i < pcm16.length; i++) buf.writeInt16LE(pcm16[i], i * 2);
        pushStream.write(buf);
        break;
      }

      case "stop":
        console.log("Stream stop received");
        ws.close();
        break;
    }
  });

  ws.on("close", () => {
    console.log("Twilio WebSocket closed");
    try {
      pushStream?.close();
    } catch {}
    try {
      rec?.stopContinuousRecognitionAsync(
        () => rec.close(),
        () => rec.close()
      );
    } catch {}
  });

  ws.on("error", (e) => console.error("WS error:", e?.message || e));
});

// Start the server
server.listen(PORT, "0.0.0.0", () => console.log(`WS relay listening on :${PORT}`));
