import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../../src/db/database.js";

async function stalledPostgres(acceptStartup: boolean) {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // Act as a PostgreSQL peer that accepts the TCP socket but stops responding.
    // For the query test, complete the protocol handshake before the stall.
    if (acceptStartup) {
      socket.once("data", () => {
        socket.write(
          Buffer.from([
            0x52,
            0,
            0,
            0,
            8,
            0,
            0,
            0,
            0, // AuthenticationOk
            0x5a,
            0,
            0,
            0,
            5,
            0x49, // ReadyForQuery (idle)
          ]),
        );
      });
    }
    socket.on("data", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing test server address");
  return {
    connectionString: `postgresql://test@127.0.0.1:${address.port}/test?sslmode=disable`,
    connections: () => connections,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

describe("database network deadlines", () => {
  it("rejects an unresponsive PostgreSQL handshake instead of waiting forever", async () => {
    const peer = await stalledPostgres(false);
    const database = createDatabase(peer.connectionString, {
      connectionTimeoutMillis: 50,
    });
    try {
      await expect(sql`select 1`.execute(database)).rejects.toThrow(/timeout/i);
    } finally {
      await peer.close();
      await database.destroy();
    }
  });

  it("rejects a query when an established connection stops replying", async () => {
    const peer = await stalledPostgres(true);
    const database = createDatabase(peer.connectionString, {
      connectionTimeoutMillis: 1_000,
      queryTimeoutMillis: 50,
    });
    try {
      await expect(sql`select 1`.execute(database)).rejects.toThrow(
        /query read timeout/i,
      );
      await expect(sql`select 1`.execute(database)).rejects.toThrow(
        /query read timeout/i,
      );
      expect(peer.connections()).toBe(2);
      // Closing the pool must finish while the peer is still stalled. Merely
      // rejecting the query leaves pg's active socket and shutdown hanging.
      await database.destroy();
    } finally {
      await peer.close();
      await database.destroy();
    }
  });
});
