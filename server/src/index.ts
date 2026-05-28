import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import "dotenv/config";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { AiService } from "./ai.js";
import { AppDatabase } from "./db.js";
import { registerRoutes } from "./routes.js";
import { createSocketServer } from "./sockets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });
const db = new AppDatabase();
const ai = new AiService();
const sockets = createSocketServer(app.server, db);

await app.register(cors, {
  origin: process.env.CLIENT_ORIGIN || true
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  if (error instanceof ZodError) {
    return reply.status(400).send({ message: "请求参数不正确。", issues: error.issues });
  }
  const normalized = error instanceof Error ? error : new Error("服务器内部错误。");
  if (normalized.name === "PrivacyError") {
    return reply.status(422).send({ message: normalized.message });
  }
  const statusCode = (normalized as Error & { statusCode?: number }).statusCode ?? 500;
  return reply.status(statusCode).send({ message: normalized.message || "服务器内部错误。" });
});

registerRoutes(app, db, ai, (code) => sockets.broadcastSnapshot(code));

const clientDist = resolve(process.cwd(), "dist/client");
if (existsSync(join(clientDist, "index.html"))) {
  await app.register(fastifyStatic, {
    root: clientDist
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api") || request.raw.url?.startsWith("/socket.io")) {
      return reply.status(404).send({ message: "接口不存在。" });
    }
    return reply.sendFile("index.html");
  });
}

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "0.0.0.0";
await app.listen({ port, host });
