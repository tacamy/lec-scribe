/**
 * Appends recorder chunks to a file in the Origin Private File System.
 *
 * Runs in a dedicated worker because createSyncAccessHandle() is only
 * available there. Every append is flushed, so a crash loses at most the
 * chunk in flight (SPEC D-06). The file stays locked while open; the main
 * thread reads it only after CLOSE.
 */
export type WriterRequest =
  | { id: number; type: 'OPEN'; path: string[] }
  | { id: number; type: 'APPEND'; buffer: ArrayBuffer }
  | { id: number; type: 'CLOSE' };

export type WriterResponse = { id: number; ok: true; bytes: number } | { id: number; ok: false; error: string };

// createSyncAccessHandle is declared in the WebWorker lib only; declare the
// small surface used here instead of mixing DOM and WebWorker libs.
type SyncAccessHandle = {
  getSize(): number;
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  flush(): void;
  close(): void;
};
type SyncCapableFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WriterRequest>) => void) | null;
  postMessage(msg: WriterResponse): void;
};

let handle: SyncAccessHandle | null = null;
let size = 0;

scope.onmessage = async (e) => {
  const req = e.data;
  try {
    switch (req.type) {
      case 'OPEN': {
        if (handle) throw new Error('already open');
        const name = req.path[req.path.length - 1];
        if (!name) throw new Error('empty path');
        let dir = await navigator.storage.getDirectory();
        for (const part of req.path.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
        const file = (await dir.getFileHandle(name, { create: true })) as SyncCapableFileHandle;
        handle = await file.createSyncAccessHandle();
        size = handle.getSize();
        break;
      }
      case 'APPEND': {
        if (!handle) throw new Error('not open');
        const written = handle.write(new Uint8Array(req.buffer), { at: size });
        size += written;
        handle.flush();
        break;
      }
      case 'CLOSE': {
        if (handle) {
          handle.flush();
          handle.close();
          handle = null;
        }
        break;
      }
    }
    scope.postMessage({ id: req.id, ok: true, bytes: size });
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
