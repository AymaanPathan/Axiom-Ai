import { Server as IOServer } from "socket.io";
import type { Server as HTTPServer } from "node:http";

let io: IOServer | undefined;

export function initSocket(httpServer: HTTPServer): IOServer {
  io = new IOServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:5173",
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    socket.on("run:subscribe", (runId: string) => socket.join(`run:${runId}`));
    socket.on("run:unsubscribe", (runId: string) =>
      socket.leave(`run:${runId}`),
    );
  });

  return io;
}

export function getIO(): IOServer {
  if (!io)
    throw new Error("Socket.IO not initialized — call initSocket() first");
  return io;
}
