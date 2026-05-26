import express from "express";
import { spawn } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "8mb" }));

// Map AFFiNE model names to actual Ollama models
const modelMap = {
  "gpt-4": "gemma4:26b",
  "gpt-4-turbo": "gemma4:26b",
  "gpt-3.5-turbo": "gemma4:26b",
};

// ---------- /v1/responses - proxy to Ollama's native responses endpoint ----------
app.post("/v1/responses", async (req, res) => {
  try {
    const body = req.body || {};
    const model = body.model;
    const actualModel = modelMap[model] || model || "gemma4:26b";

    // Replace model name
    const requestBody = { ...body, model: actualModel };

    console.log(`[RESPONSES] AFFiNE requested model: ${model}, using: ${actualModel}`);
    console.log(`[RESPONSES] Request size: ${JSON.stringify(requestBody).length} bytes`);

    const upstreamUrl = `${process.env.LITELLM_URL}/v1/responses`;
    console.log(`[RESPONSES] Proxying to: ${upstreamUrl}`);

    // Write request to temp file
    const tmpFile = `/tmp/req_${Date.now()}.json`;
    fs.writeFileSync(tmpFile, JSON.stringify(requestBody));

    // Use curl to proxy the request
    const curlArgs = [
      '-s',
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${process.env.LITELLM_KEY}`,
      '-d', `@${tmpFile}`,
      upstreamUrl
    ];

    const curl = spawn('curl', curlArgs);
    console.log(`[RESPONSES] curl spawned with PID: ${curl.pid}`);

    let output = '';

    curl.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    curl.stderr.on('data', (data) => {
      console.error(`[RESPONSES] curl stderr: ${data}`);
    });

    curl.on('error', (err) => {
      console.error(`[RESPONSES] curl error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });

    curl.on('close', (code) => {
      console.log(`[RESPONSES] curl closed with code: ${code}`);
      try { fs.unlinkSync(tmpFile); } catch {}

      if (code !== 0) {
        res.status(500).json({ error: `curl exited with code ${code}` });
        return;
      }

      try {
        const result = JSON.parse(output);

        // Filter out reasoning/thinking from the output array
        if (result.output && Array.isArray(result.output)) {
          result.output = result.output.filter(item => item.type !== 'reasoning');
        }

        res.json(result);
      } catch (e) {
        console.error(`[RESPONSES] Failed to parse: ${e.message}`);
        res.status(500).json({ error: "Failed to parse response" });
      }
    });

  } catch (err) {
    console.error(`[RESPONSES] Error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ---------- models endpoint ----------
app.get("/v1/models", async (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "gpt-4", object: "model", created: Date.now(), owned_by: "ollama" },
      { id: "gpt-4-turbo", object: "model", created: Date.now(), owned_by: "ollama" },
      { id: "gpt-3.5-turbo", object: "model", created: Date.now(), owned_by: "ollama" },
      { id: "text-embedding-3-large", object: "model", created: Date.now(), owned_by: "ollama" },
      { id: "text-embedding-3-small", object: "model", created: Date.now(), owned_by: "ollama" },
    ]
  });
});

// ---------- embeddings endpoint ----------
app.post("/v1/embeddings", async (req, res) => {
  try {
    const { input, model } = req.body || {};
    const actualModel = "qwen3-embedding:8b";

    console.log(`[EMBEDDINGS] AFFiNE requested model: ${model}, using: ${actualModel}`);

    // Use curl to proxy
    const tmpFile = `/tmp/emb_${Date.now()}.json`;
    fs.writeFileSync(tmpFile, JSON.stringify({ model: actualModel, input }));

    const curlArgs = [
      '-s',
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${process.env.LITELLM_KEY}`,
      '-d', `@${tmpFile}`,
      `${process.env.LITELLM_URL}/v1/embeddings`
    ];

    const curl = spawn('curl', curlArgs);
    let output = '';

    curl.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    curl.stderr.on('data', (data) => {
      console.error(`[EMBEDDINGS] curl stderr: ${data}`);
    });

    curl.on('close', (code) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (code === 0) {
        try {
          const result = JSON.parse(output);
          result.model = model || "text-embedding-3-large";
          res.json(result);
        } catch (e) {
          res.status(500).json({ error: "Failed to parse response" });
        }
      } else {
        res.status(500).json({ error: `curl exited with code ${code}` });
      }
    });

  } catch (err) {
    console.error(`[EMBEDDINGS] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------- pass-through for other endpoints ----------
app.all("*", (req, res) => {
  console.log(`[PASSTHROUGH] ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "Not found" });
});

// ---------- start ----------
app.listen(process.env.PORT || 4011, () => {
  console.log(`responses-adapter listening on ${process.env.PORT || 4011}`);
  console.log(`Proxying to: ${process.env.LITELLM_URL}`);
});
