// Saving files: native Save dialog in the desktop app, browser download otherwise.
const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function saveBytes(defaultName: string, bytes: Uint8Array, filter: { name: string; extensions: string[] }): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await save({ defaultPath: defaultName, filters: [filter] });
    if (!path) return false;
    await invoke('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
    return true;
  }
  const blob = new Blob([bytes as BlobPart]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

export const safeName = (s: string) => s.replace(/[^\w\-. ]+/g, '_').trim() || 'export';
