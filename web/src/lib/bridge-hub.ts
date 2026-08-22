/** Several daemon WS clients keyed by server id. */

import { CcopWsBridge, type ProxyTarget } from "./ws-proxy";
import type { WatchEvent } from "./protocol";

export type HubRow = {
  id: string;
  connected: boolean;
  host: string;
  port: number;
};

export class BridgeHub {
  private bridges = new Map<string, CcopWsBridge>();
  private hooked = new Set<string>();
  private frameFans = new Set<(text: string) => void>();
  private eventFans = new Set<(ev: WatchEvent & { serverId: string }) => void>();

  ensure(id: string): CcopWsBridge {
    let b = this.bridges.get(id);
    if (!b) {
      b = new CcopWsBridge();
      this.bridges.set(id, b);
    }
    if (!this.hooked.has(id)) {
      this.hooked.add(id);
      const sid = id;
      const br = b;
      br.onFrame((text) => {
        for (const cb of this.frameFans) cb(text);
      });
      br.watch((ev) => {
        const tagged = { ...ev, serverId: sid };
        for (const cb of this.eventFans) cb(tagged);
      });
    }
    return b;
  }

  get(id: string | undefined | null): CcopWsBridge | undefined {
    if (!id) return undefined;
    return this.bridges.get(id);
  }

  ids(): string[] {
    return [...this.bridges.keys()];
  }

  list(): HubRow[] {
    const rows: HubRow[] = [];
    for (const [id, b] of this.bridges) {
      const t = b.getTarget();
      rows.push({
        id,
        connected: b.isConnected(),
        host: t?.host || "",
        port: t?.port || 0,
      });
    }
    return rows;
  }

  primaryConnected(): CcopWsBridge | undefined {
    for (const b of this.bridges.values()) {
      if (b.isConnected()) return b;
    }
    return undefined;
  }

  primaryConnectedId(): string | null {
    for (const [id, b] of this.bridges) {
      if (b.isConnected()) return id;
    }
    return null;
  }

  primary(): CcopWsBridge {
    return this.primaryConnected() ?? this.ensure("default");
  }

  anyConnected(): boolean {
    return Boolean(this.primaryConnected());
  }

  async connect(
    id: string,
    target: ProxyTarget,
  ): Promise<{ ok: true; ping: Record<string, unknown> } | { ok: false; error: string }> {
    const b = this.ensure(id);
    return b.connect(target);
  }

  async disconnect(id: string): Promise<void> {
    const b = this.bridges.get(id);
    if (b) await b.disconnect();
  }

  pick(serverId?: string): CcopWsBridge | undefined {
    if (serverId) {
      const named = this.bridges.get(serverId);
      if (named) return named;
    }
    return this.primaryConnected();
  }

  onAnyFrame(cb: (text: string) => void): () => void {
    this.frameFans.add(cb);
    return () => {
      this.frameFans.delete(cb);
    };
  }

  watchAll(cb: (ev: WatchEvent & { serverId: string }) => void): () => void {
    this.eventFans.add(cb);
    for (const id of this.bridges.keys()) this.ensure(id);
    return () => {
      this.eventFans.delete(cb);
    };
  }
}
