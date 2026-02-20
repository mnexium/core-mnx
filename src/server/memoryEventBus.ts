export interface MemoryEvent {
  type: string;
  project_id: string;
  subject_id: string | null;
  data: Record<string, unknown>;
  timestamp: string;
}

type Subscriber = (event: MemoryEvent) => void;

function key(projectId: string, subjectId: string | null): string {
  return `${projectId}:${subjectId || "*"}`;
}

export class MemoryEventBus {
  private subscribers = new Map<string, Set<Subscriber>>();

  subscribe(projectId: string, subjectId: string | null, cb: Subscriber): () => void {
    const k = key(projectId, subjectId);
    if (!this.subscribers.has(k)) this.subscribers.set(k, new Set());
    this.subscribers.get(k)?.add(cb);
    return () => {
      const set = this.subscribers.get(k);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) this.subscribers.delete(k);
    };
  }

  emit(projectId: string, subjectId: string | null, type: string, data: Record<string, unknown>) {
    const event: MemoryEvent = {
      type,
      project_id: projectId,
      subject_id: subjectId,
      data,
      timestamp: new Date().toISOString(),
    };

    const specific = this.subscribers.get(key(projectId, subjectId));
    specific?.forEach((cb) => {
      try {
        cb(event);
      } catch {
        // Ignore callback failures to avoid breaking fan-out.
      }
    });

    const projectWide = this.subscribers.get(key(projectId, null));
    projectWide?.forEach((cb) => {
      try {
        cb(event);
      } catch {
        // Ignore callback failures to avoid breaking fan-out.
      }
    });
  }
}
