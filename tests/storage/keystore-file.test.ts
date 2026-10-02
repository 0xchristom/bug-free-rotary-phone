import { describe, expect, it, vi } from 'vitest';
import { AppError, MAX_KEYSTORE_FILE_BYTES } from '../../src/core/index.ts';
import {
  DOWNLOAD_URL_TTL_MS,
  keystoreFileName,
  openKeystoreFile,
  readKeystoreFile,
  saveKeystoreFile,
  supportsDirectoryPicker,
  type DirectoryHandleLike,
  type FileLike,
  type StorageEnv,
  type WritableLike,
} from '../../src/storage/keystore-file.ts';

const FILE_TEXT = '{"version":1,"ciphertext":"…encrypted…"}';

function domError(name: string): Error {
  return new DOMException('browser message with details', name);
}

/** In-memory folder implementing the File System Access handles we use. */
function fakeFolder(existing: Record<string, string> = {}) {
  const files = new Map(Object.entries(existing));
  const writes: string[] = [];
  const events: string[] = [];
  let failWrite: Error | undefined;
  let failCreateWritable: Error | undefined;
  const dir: DirectoryHandleLike = {
    name: 'Portfele',
    getFileHandle: (name, options) => {
      events.push(`getFileHandle:${name}:${options?.create ? 'create' : 'lookup'}`);
      if (!files.has(name) && !options?.create) return Promise.reject(domError('NotFoundError'));
      return Promise.resolve({
        getFile: () =>
          Promise.resolve({ name, size: 0, text: () => Promise.resolve(files.get(name) ?? '') }),
        createWritable: () => {
          if (failCreateWritable) return Promise.reject(failCreateWritable);
          let buffer = '';
          const writable: WritableLike = {
            write: (data) => {
              if (failWrite) return Promise.reject(failWrite);
              buffer += data;
              return Promise.resolve();
            },
            close: () => {
              files.set(name, buffer);
              writes.push(name);
              return Promise.resolve();
            },
            abort: () => {
              events.push('abort');
              return Promise.resolve();
            },
          };
          return Promise.resolve(writable);
        },
      });
    },
  };
  return {
    dir,
    files,
    writes,
    events,
    failWrites: (e: Error) => (failWrite = e),
    failCreateWritable: (e: Error) => (failCreateWritable = e),
  };
}

function env(overrides: Partial<StorageEnv> = {}): StorageEnv & {
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
  clickDownload: ReturnType<typeof vi.fn>;
} {
  return {
    pickFileWithInput: vi.fn(() => Promise.resolve(null)),
    createObjectURL: vi.fn(() => 'blob:fake-url'),
    revokeObjectURL: vi.fn(),
    clickDownload: vi.fn(),
    // real timers by default; tests that check the delay use vi.useFakeTimers()
    setTimeout: (callback: () => void, ms: number) => {
      setTimeout(callback, ms);
    },
    ...overrides,
  } as ReturnType<typeof env>;
}

async function expectCode(promise: Promise<unknown>, code: AppError['code']): Promise<AppError> {
  const caught: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
  // browser messages never leak into our errors
  expect((caught as AppError).message).not.toContain('browser message');
  return caught as AppError;
}

describe('keystoreFileName', () => {
  it.each([
    ['Flota 1', 'Flota 1.keystore.json'],
    ['Żółw_2.0', 'Żółw_2.0.keystore.json'],
    ['a'.repeat(64), `${'a'.repeat(64)}.keystore.json`],
  ])('%j → %j', (name, file) => {
    expect(keystoreFileName(name)).toBe(file);
  });

  it.each([
    '',
    '../evil',
    'a/b',
    'a\\b',
    'C:x',
    'x*?',
    '"q"',
    '<x>',
    'pipe|',
    '.hidden',
    'end.',
    'CON',
    'nul',
    'a\nb',
    'a'.repeat(65),
  ])('%j → INVALID_FLEET_NAME', (name) => {
    let caught: unknown;
    try {
      keystoreFileName(name);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('INVALID_FLEET_NAME');
  });
});

describe('saveKeystoreFile with the File System Access API', () => {
  it('writes a new file into the picked folder (readwrite)', async () => {
    const folder = fakeFolder();
    const picker = vi.fn(() => Promise.resolve(folder.dir));
    const confirmOverwrite = vi.fn(() => true);
    const e = env({ showDirectoryPicker: picker });
    expect(supportsDirectoryPicker(e)).toBe(true);

    const result = await saveKeystoreFile(FILE_TEXT, 'Flota', e, { confirmOverwrite });
    expect(result).toEqual({
      method: 'directory',
      fileName: 'Flota.keystore.json',
      folder: 'Portfele',
    });
    expect(picker).toHaveBeenCalledWith({ id: 'bunndly-keystore', mode: 'readwrite' });
    expect(folder.files.get('Flota.keystore.json')).toBe(FILE_TEXT);
    expect(confirmOverwrite).not.toHaveBeenCalled();
    expect(e.clickDownload).not.toHaveBeenCalled();
  });

  it('overwrites an existing file only after confirmation', async () => {
    const folder = fakeFolder({ 'Flota.keystore.json': 'OLD' });
    const confirmOverwrite = vi.fn(() => Promise.resolve(true));
    await saveKeystoreFile(
      FILE_TEXT,
      'Flota',
      env({ showDirectoryPicker: () => Promise.resolve(folder.dir) }),
      {
        confirmOverwrite,
      },
    );
    expect(confirmOverwrite).toHaveBeenCalledWith('Flota.keystore.json');
    expect(folder.files.get('Flota.keystore.json')).toBe(FILE_TEXT);
  });

  it('keeps the existing file when overwrite is declined', async () => {
    const folder = fakeFolder({ 'Flota.keystore.json': 'OLD' });
    await expectCode(
      saveKeystoreFile(
        FILE_TEXT,
        'Flota',
        env({ showDirectoryPicker: () => Promise.resolve(folder.dir) }),
        {
          confirmOverwrite: () => false,
        },
      ),
      'STORAGE_CANCELLED',
    );
    expect(folder.files.get('Flota.keystore.json')).toBe('OLD');
    expect(folder.writes).toEqual([]);
    expect(folder.events).not.toContain('getFileHandle:Flota.keystore.json:create');
  });

  it('cancelled folder picker → STORAGE_CANCELLED', async () => {
    await expectCode(
      saveKeystoreFile(
        FILE_TEXT,
        'Flota',
        env({ showDirectoryPicker: () => Promise.reject(domError('AbortError')) }),
        {
          confirmOverwrite: () => true,
        },
      ),
      'STORAGE_CANCELLED',
    );
  });

  it.each(['NotAllowedError', 'SecurityError'])('%s → STORAGE_PERMISSION_DENIED', async (name) => {
    await expectCode(
      saveKeystoreFile(
        FILE_TEXT,
        'Flota',
        env({ showDirectoryPicker: () => Promise.reject(domError(name)) }),
        {
          confirmOverwrite: () => true,
        },
      ),
      'STORAGE_PERMISSION_DENIED',
    );
    const folder = fakeFolder();
    folder.failCreateWritable(domError(name));
    await expectCode(
      saveKeystoreFile(
        FILE_TEXT,
        'Flota',
        env({ showDirectoryPicker: () => Promise.resolve(folder.dir) }),
        {
          confirmOverwrite: () => true,
        },
      ),
      'STORAGE_PERMISSION_DENIED',
    );
  });

  it('a failing write aborts the writable and gives STORAGE_WRITE_FAILED', async () => {
    const folder = fakeFolder({ 'Flota.keystore.json': 'OLD' });
    folder.failWrites(domError('QuotaExceededError'));
    await expectCode(
      saveKeystoreFile(
        FILE_TEXT,
        'Flota',
        env({ showDirectoryPicker: () => Promise.resolve(folder.dir) }),
        {
          confirmOverwrite: () => true,
        },
      ),
      'STORAGE_WRITE_FAILED',
    );
    expect(folder.events).toContain('abort');
    expect(folder.files.get('Flota.keystore.json')).toBe('OLD');
  });

  it('rejects an unsafe fleet name before opening any picker', async () => {
    const picker = vi.fn();
    await expectCode(
      saveKeystoreFile(FILE_TEXT, '../x', env({ showDirectoryPicker: picker }), {
        confirmOverwrite: () => true,
      }),
      'INVALID_FLEET_NAME',
    );
    expect(picker).not.toHaveBeenCalled();
  });
});

describe('saveKeystoreFile fallback (no File System Access API)', () => {
  it('downloads the file and revokes the object URL only after the delay', async () => {
    vi.useFakeTimers();
    const e = env();
    expect(supportsDirectoryPicker(e)).toBe(false);
    const result = await saveKeystoreFile(FILE_TEXT, 'Flota', e, { confirmOverwrite: () => true });
    expect(result).toEqual({ method: 'download', fileName: 'Flota.keystore.json' });
    expect(e.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = e.createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe(FILE_TEXT);
    expect(e.clickDownload).toHaveBeenCalledWith('blob:fake-url', 'Flota.keystore.json');
    // the URL stays valid while the browser downloads it
    expect(e.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DOWNLOAD_URL_TTL_MS - 1);
    expect(e.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(e.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(e.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
    expect(DOWNLOAD_URL_TTL_MS).toBe(60_000);
    vi.useRealTimers();
  });

  it('revokes the URL at once if the click throws', async () => {
    const e = env({
      clickDownload: vi.fn(() => {
        throw new Error('blocked');
      }),
    });
    await expectCode(
      saveKeystoreFile(FILE_TEXT, 'Flota', e, { confirmOverwrite: () => true }),
      'STORAGE_WRITE_FAILED',
    );
    expect(e.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });
});

describe('openKeystoreFile / readKeystoreFile', () => {
  function fakeFile(
    size: number,
    content = FILE_TEXT,
  ): FileLike & { readSpy: ReturnType<typeof vi.fn> } {
    const readSpy = vi.fn(() => Promise.resolve(content));
    return { name: 'Flota.keystore.json', size, text: readSpy, readSpy };
  }

  it('reads through showOpenFilePicker with a .json filter', async () => {
    const file = fakeFile(FILE_TEXT.length);
    const picker = vi.fn(() => Promise.resolve([{ getFile: () => Promise.resolve(file) }]));
    const opened = await openKeystoreFile(env({ showOpenFilePicker: picker }));
    expect(opened).toEqual({ name: 'Flota.keystore.json', text: FILE_TEXT });
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        types: [expect.objectContaining({ accept: { 'application/json': ['.json'] } })],
      }),
    );
  });

  it('falls back to <input type="file"> with a .json accept filter', async () => {
    const file = fakeFile(10);
    const pick = vi.fn(() => Promise.resolve(file));
    const opened = await openKeystoreFile(env({ pickFileWithInput: pick }));
    expect(opened.text).toBe(FILE_TEXT);
    expect(pick).toHaveBeenCalledWith('.json,application/json');
  });

  it('cancel in either picker → STORAGE_CANCELLED', async () => {
    await expectCode(openKeystoreFile(env()), 'STORAGE_CANCELLED');
    await expectCode(
      openKeystoreFile(env({ showOpenFilePicker: () => Promise.reject(domError('AbortError')) })),
      'STORAGE_CANCELLED',
    );
  });

  it('permission and read errors map to Polish codes', async () => {
    await expectCode(
      openKeystoreFile(
        env({ showOpenFilePicker: () => Promise.reject(domError('NotAllowedError')) }),
      ),
      'STORAGE_PERMISSION_DENIED',
    );
    const broken: FileLike = {
      name: 'x.json',
      size: 5,
      text: () => Promise.reject(domError('NotReadableError')),
    };
    await expectCode(readKeystoreFile(broken), 'STORAGE_READ_FAILED');
  });

  it('rejects a file over 1 MB without reading its content', async () => {
    const big = fakeFile(MAX_KEYSTORE_FILE_BYTES + 1);
    await expectCode(readKeystoreFile(big), 'STORAGE_FILE_TOO_LARGE');
    expect(big.readSpy).not.toHaveBeenCalled();
    await expectCode(
      openKeystoreFile(env({ pickFileWithInput: () => Promise.resolve(big) })),
      'STORAGE_FILE_TOO_LARGE',
    );
    expect(big.readSpy).not.toHaveBeenCalled();
    // exactly 1 MB is still allowed
    const edge = fakeFile(MAX_KEYSTORE_FILE_BYTES);
    expect((await readKeystoreFile(edge)).text).toBe(FILE_TEXT);
  });
});
