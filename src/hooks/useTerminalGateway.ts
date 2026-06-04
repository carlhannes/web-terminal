import { useEffect, useRef, useState } from "react";

import { TerminalGatewayClient, type GatewayStatus } from "@/lib/terminal-gateway";
import type { SessionInfo } from "@/components/terminal/types";

// Thin React binding over the gateway client. Mirrors ONLY the structural snapshot
// (sessions) + connection status into React state; per-pane output bypasses React
// entirely (components subscribe via client.subscribeOutput).
export function useTerminalGateway(): {
  client: TerminalGatewayClient;
  sessions: SessionInfo[];
  status: GatewayStatus;
} {
  const clientRef = useRef<TerminalGatewayClient | null>(null);
  if (clientRef.current === null) clientRef.current = new TerminalGatewayClient();
  const client = clientRef.current;

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [status, setStatus] = useState<GatewayStatus>("connecting");

  useEffect(() => {
    const offSessions = client.onSessions(setSessions);
    const offStatus = client.onStatus(setStatus);
    client.connect();
    return () => {
      offSessions();
      offStatus();
      client.disconnect(); // reconnectable; survives StrictMode remount
    };
  }, [client]);

  return { client, sessions, status };
}
