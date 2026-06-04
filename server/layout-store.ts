import { promises as fs } from "node:fs";
import path from "node:path";

import { type DesktopLayout, type UserLayout, UserLayoutSchema } from "./protocol";
import { sanitizeUser } from "./tmux";
import { log } from "./log";

// Best-effort per-user layout persistence (a JSON sidecar). tmux is the source of
// truth for which windows exist; this only remembers the WEB arrangement (tab
// grouping, split tree, sizes). Reconcile logic lives in protocol.ts (pure, shared
// with the client). On read, callers reconcile against the live window list.

// ---------------------------- persistence ----------------------------

const WRITE_DEBOUNCE_MS = 500;

export class LayoutStore {
  private cache = new Map<string, UserLayout>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private dir: string) {}

  private file(user: string): string {
    return path.join(this.dir, `${sanitizeUser(user)}.json`);
  }

  async load(user: string): Promise<UserLayout> {
    const cached = this.cache.get(user);
    if (cached) return cached;
    let layout: UserLayout = { version: 1, desktops: {} };
    try {
      const raw = await fs.readFile(this.file(user), "utf8");
      const parsed = UserLayoutSchema.safeParse(JSON.parse(raw));
      if (parsed.success) layout = parsed.data;
      else log.warn("layout file invalid, ignoring", { user });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("layout read failed", { user, err: String(err) });
      }
    }
    this.cache.set(user, layout);
    return layout;
  }

  async getDesktop(user: string, session: string): Promise<DesktopLayout | undefined> {
    const layout = await this.load(user);
    return layout.desktops[session];
  }

  async setDesktop(user: string, session: string, desktop: DesktopLayout): Promise<void> {
    const layout = await this.load(user);
    layout.desktops[session] = desktop;
    this.scheduleWrite(user);
  }

  async removeDesktop(user: string, session: string): Promise<void> {
    const layout = await this.load(user);
    if (layout.desktops[session]) {
      delete layout.desktops[session];
      this.scheduleWrite(user);
    }
  }

  private scheduleWrite(user: string) {
    const existing = this.timers.get(user);
    if (existing) clearTimeout(existing);
    this.timers.set(
      user,
      setTimeout(() => {
        this.timers.delete(user);
        void this.flush(user);
      }, WRITE_DEBOUNCE_MS),
    );
  }

  private async flush(user: string): Promise<void> {
    const layout = this.cache.get(user);
    if (!layout) return;
    const file = this.file(user);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(layout, null, 2), { mode: 0o600 });
      await fs.rename(tmp, file); // atomic replace
    } catch (err) {
      log.warn("layout write failed", { user, err: String(err) });
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }
}
