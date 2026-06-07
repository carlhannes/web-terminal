import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { TerminalSquare } from "lucide-react";

import { gatewayHttpBase } from "@/lib/terminal-gateway";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — Web Terminal" },
      { name: "description", content: "Connect to your SSH session in the browser." },
    ],
  }),
  component: LoginPage,
  ssr: false,
});

// Map the gateway's auth response to a human message. The gateway distinguishes a
// wrong password from an unreachable host (502 / reason "host-unreachable") so a reboot
// that breaks container->host networking no longer reads as a credentials problem.
function messageForError(status: number, reason?: string): string {
  if (status === 429) return "Too many attempts — please wait and try again.";
  if (status === 502 || reason === "host-unreachable")
    return "Can't reach the SSH host — check it's running and reachable from the gateway.";
  if (reason === "host-key") return "Host key changed or untrusted — contact the administrator.";
  return "Wrong username or password.";
}

function LoginPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${gatewayHttpBase()}/auth`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: user, password: pass }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        setError(messageForError(res.status, body.reason));
        setLoading(false);
        return;
      }
      // Gateway set an HttpOnly session cookie; the /app WebSocket will use it.
      void navigate({ to: "/app" });
    } catch {
      setError("Could not reach the terminal gateway.");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm"
      >
        <div className="mb-6 flex items-center gap-2 text-foreground">
          <TerminalSquare size={20} />
          <h1 className="text-base font-semibold tracking-tight">Web Terminal</h1>
        </div>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-muted-foreground">SSH username</span>
          <input
            autoFocus
            value={user}
            onChange={(e) => setUser(e.target.value)}
            // text-base = 16px: below 16px iOS Safari auto-zooms the page on input focus.
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-base text-foreground outline-none focus:border-ring"
            placeholder="root"
            autoComplete="username"
          />
        </label>
        <label className="mb-5 block">
          <span className="mb-1 block text-xs text-muted-foreground">Password</span>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            // text-base = 16px: below 16px iOS Safari auto-zooms the page on input focus.
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-base text-foreground outline-none focus:border-ring"
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </label>
        {error && <p className="mb-3 text-xs text-destructive">{error}</p>}
        <button
          type="submit"
          disabled={loading || !user || !pass}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? "Connecting…" : "Connect"}
        </button>
        <p className="mt-3 text-center text-[11px] text-muted-foreground">
          Connects over SSH to the configured host; your terminals persist via tmux. Sessions are
          in-memory — after a server reboot you sign in again.
        </p>
      </form>
    </div>
  );
}
