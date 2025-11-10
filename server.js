import express from "express";

const app = express();
app.use(express.json({ limit: "8mb" }));

// ---------- helpers ----------
function sseHeaders(res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}
function sendSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// extract text from many shapes AFFiNE might send
function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // array of parts like [{type:'input_text', text:'...'}, ...]
    return content
      .map(p => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") return p.text ?? p.content ?? "";
        return "";
      })
      .join("");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    // last resort: stringify
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return String(content);
}

function normalizeOneMessage(m) {
  const role = (m?.role === "system" || m?.role === "assistant" || m?.role === "user")
    ? m.role : "user";
  const content = extractText(m?.content);
  return { role, content };
}

function normalizeMessagesFromBody(body) {
  // 1) If body.messages exists and is array, normalize those
  if (Array.isArray(body?.messages)) {
    return body.messages.map(normalizeOneMessage);
  }

  // 2) Responses API often uses `input`
  const input = body?.input;

  //   2a) input is already an array of messages
  if (Array.isArray(input) && input.length && (input[0]?.role || input[0]?.content)) {
    return input.map(normalizeOneMessage);
  }

  //   2b) input is a single message-like object
  if (input && typeof input === "object" && ("role" in input || "content" in input)) {
    return [normalizeOneMessage(input)];
  }

  //   2c) input is array of parts / strings
  if (Array.isArray(input)) {
    return [{ role: "user", content: extractText(input) }];
  }

  //   2d) input is plain text or something else
  return [{ role: "user", content: extractText(input) }];
}

async function passthru(req, res, path) {
  const r = await fetch(`${process.env.LITELLM_URL}${path}`, {
    method: req.method,
    headers: {
      "Authorization": `Bearer ${process.env.LITELLM_KEY}`,
      "Content-Type": req.get("content-type") || "application/json",
    },
    body: ["GET","HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
  });
  res.status(r.status);
  r.headers.forEach((v, k) => { if (!["content-length","transfer-encoding"].includes(k)) res.setHeader(k, v); });
  if (!r.body) return res.end();
  const reader = r.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

// ---------- /v1/responses adapter ----------
app.post("/v1/responses", async (req, res) => {
  try {
    const { model, stream = true } = req.body || {};

    // Map AFFiNE model names to actual Ollama models
    const modelMap = {
      "gpt-4": "gpt-oss:120b",
      "gpt-4-turbo": "gpt-oss:120b",
      "gpt-3.5-turbo": "gpt-oss:120b",
    };
    const actualModel = modelMap[model] || model || "gpt-oss:120b";

    console.log(`[RESPONSES] AFFiNE requested model: ${model}, using: ${actualModel}`);

    // Normalize to OpenAI chat messages (strings only)
    const messages = normalizeMessagesFromBody(req.body);

    // Allowed upstream params (avoid leaking unknown keys like toolsConfig)
    const {
      temperature, top_p, max_tokens, presence_penalty, frequency_penalty, stop, user, n
    } = req.body || {};

    // Stable IDs for Responses clients
    const uuid = (globalThis.crypto?.randomUUID?.() || require("crypto").randomUUID()).replace(/-/g,"");
    const msgId  = `msg_${uuid}`;
    const respId = `resp_${Buffer.from(`shim:${Date.now()}:${msgId}`).toString("base64")}`;
    const now    = Math.floor(Date.now()/1000);

    if (!stream) {
      // one-shot non-streaming
      const r = await fetch(`${process.env.LITELLM_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.LITELLM_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: actualModel, messages, stream: false,
          temperature, top_p, max_tokens, presence_penalty, frequency_penalty, stop, user, n
        }),
      });
      const j = await r.json();
      const out = j?.choices?.[0]?.message?.content ?? "";
      return res.json({
        id: respId,
        object: "response",
        model,
        status: "completed",
        created_at: now,
        output: [{
          type: "message",
          id: msgId,
          role: "assistant",
          content: [{ type: "output_text", text: out, annotations: [] }],
        }],
        usage: j?.usage ?? {},
      });
    }

    // streaming branch
    sseHeaders(res);

    // prelude required by Vercel AI/Responses consumers (AFFiNE)
    sendSSE(res, { type: "response.created", response: { id: respId, object: "response", model, created_at: now }});
    sendSSE(res, {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: msgId, type: "message", role: "assistant", status: "in_progress", content: [] }
    });
    sendSSE(res, {
      type: "response.content_part.added",
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] }
    });

    const upstream = await fetch(`${process.env.LITELLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.LITELLM_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: actualModel, messages, stream: true,
        temperature, top_p, max_tokens, presence_penalty, frequency_penalty, stop, user, n
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      // Signal error in Responses shape so client surfaces it
      sendSSE(res, {
        type: "response.error",
        error: { message: `Upstream ${upstream.status}: ${text.slice(0,300)}` }
      });
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    let full = "";
    let buffer = "";
    const reader = upstream.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const raw of chunks) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          // finish events
          sendSSE(res, { type: "response.output_text.done", item_id: msgId, output_index: 0, content_index: 0, text: full });
          sendSSE(res, {
            type: "response.content_part.done",
            item_id: msgId, output_index: 0, content_index: 0,
            part: { type: "output_text", text: full, annotations: [] }
          });
          sendSSE(res, {
            type: "response.output_item.done",
            output_index: 0,
            item: { id: msgId, type: "message", role: "assistant",
              content: [{ type: "output_text", text: full, annotations: [] }]
            }
          });
          sendSSE(res, {
            type: "response.completed",
            response: {
              id: respId, object: "response", model, status: "completed", created_at: now,
              output: [{ type: "message", id: msgId, role: "assistant",
                content: [{ type: "output_text", text: full, annotations: [] }] }],
              usage: {}
            }
          });
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        let obj;
        try { obj = JSON.parse(data); } catch { continue; }
        const delta = obj?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length) {
          full += delta;
          sendSSE(res, {
            type: "response.output_text.delta",
            item_id: msgId, output_index: 0, content_index: 0, delta
          });
        }
      }
    }
    res.end();
  } catch (err) {
    console.error(`[RESPONSES] Error: ${err.message}`);
    // defensive error reporting to client in Responses shape
    if (!res.headersSent) {
      sseHeaders(res);
      sendSSE(res, { type: "response.error", error: { message: (err?.message || "adapter error") } });
      res.write("data: [DONE]\n\n");
    }
    if (!res.finished) {
      res.end();
    }
  }
});

// ---------- models endpoint ----------
app.get("/v1/models", async (req, res) => {
  // Return models that AFFiNE expects
  res.json({
    object: "list",
    data: [
      // Chat models
      { id: "gpt-4", object: "model", created: Date.now(), owned_by: "ollama" },
      { id: "gpt-4-turbo", object: "model", created: Date.now(), owned_by: "ollama" },
      { id: "gpt-3.5-turbo", object: "model", created: Date.now(), owned_by: "ollama" },
      // Embedding models - AFFiNE only recognizes these specific ones
      { id: "text-embedding-3-large", object: "model", created: Date.now(), owned_by: "ollama" },
      { id: "text-embedding-3-small", object: "model", created: Date.now(), owned_by: "ollama" },
    ]
  });
});

// ---------- embeddings endpoint ----------
app.post("/v1/embeddings", async (req, res) => {
  try {
    const { input, model } = req.body || {};

    // Always use nomic-embed-text regardless of what AFFiNE requests
    const actualModel = "nomic-embed-text";

    console.log(`[EMBEDDINGS] AFFiNE requested model: ${model}, using: ${actualModel}`);

    const r = await fetch(`${process.env.LITELLM_URL}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.LITELLM_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: actualModel,
        input: input
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      console.error(`[EMBEDDINGS] Upstream error: ${r.status} - ${text}`);
      return res.status(r.status).json({ error: text });
    }

    const result = await r.json();
    // Ensure the response has the model name AFFiNE expects
    result.model = model || "text-embedding-3-large";

    res.json(result);
  } catch (err) {
    console.error(`[EMBEDDINGS] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------- pass-throughs ----------
app.all("*", (req, res) => passthru(req, res, req.originalUrl));

// ---------- start ----------
app.listen(process.env.PORT || 4011, () => {
  console.log(`responses-adapter listening on ${process.env.PORT || 4011}`);
});