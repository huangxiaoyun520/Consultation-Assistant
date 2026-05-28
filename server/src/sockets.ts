import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type { AppDatabase } from "./db.js";

export function createSocketServer(httpServer: HttpServer, db: AppDatabase) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
      credentials: false
    }
  });

  io.on("connection", (socket) => {
    socket.on("session:join", ({ code, participantId }: { code?: string; participantId?: string }) => {
      if (!code) return;
      const room = code.toUpperCase();
      socket.join(room);
      if (participantId) db.touchParticipant(participantId);
      io.to(room).emit("presence:updated", { code: room, at: new Date().toISOString() });
    });
  });

  return {
    io,
    broadcastSnapshot(code: string) {
      const room = code.toUpperCase();
      try {
        const snapshot = db.snapshotByCode(room);
        io.to(room).emit("session:updated", snapshot);
      } catch {
        io.to(room).emit("session:invalidated", { code: room });
      }
    }
  };
}
