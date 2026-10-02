/**
 * Real browser implementation of StorageEnv (UI thread only; not imported by tests).
 * The File System Access API is used where it exists (Chrome, Edge); elsewhere files
 * are downloaded and opened with <input type="file">.
 */
import type {
  DirectoryHandleLike,
  FileHandleLike,
  FileLike,
  OpenFilePickerOptions,
  StorageEnv,
} from './keystore-file.ts';

interface FileSystemAccessWindow {
  showDirectoryPicker?: (options: {
    readonly id: string;
    readonly mode: 'readwrite';
  }) => Promise<DirectoryHandleLike>;
  showOpenFilePicker?: (options: OpenFilePickerOptions) => Promise<FileHandleLike[]>;
}

function pickFileWithInput(accept: string): Promise<FileLike | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => {
      resolve(null);
    });
    input.click();
  });
}

function clickDownload(url: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
  }
}

export function browserStorageEnv(): StorageEnv {
  const fsa = window as unknown as FileSystemAccessWindow;
  return {
    ...(typeof fsa.showDirectoryPicker === 'function'
      ? { showDirectoryPicker: fsa.showDirectoryPicker.bind(window) }
      : {}),
    ...(typeof fsa.showOpenFilePicker === 'function'
      ? { showOpenFilePicker: fsa.showOpenFilePicker.bind(window) }
      : {}),
    pickFileWithInput,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => {
      URL.revokeObjectURL(url);
    },
    clickDownload,
  };
}
