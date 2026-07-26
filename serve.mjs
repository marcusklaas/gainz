// Minimal static server. ES modules need an http origin; file:// will not work.
// node serve.mjs  ->  http://localhost:8080
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".csv": "text/csv",
};

createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const rel = normalize(url === "/" ? "index.html" : url.slice(1)).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = await readFile(join(import.meta.dirname, rel));
    res.writeHead(200, {
      "content-type": TYPES[extname(rel)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(8080, () => console.log("http://localhost:8080"));
