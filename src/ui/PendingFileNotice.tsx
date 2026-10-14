import { supportsDirectoryPicker, type StorageEnv } from '../storage/keystore-file.ts';
import type { PendingFileState } from './use-pending-file.ts';
import { Button } from './kit/index.ts';

/** Under the header: the fleet file the disk lacks, also after a reload (BUNNDLY-80). */
export function PendingFileNotice({
  pending,
  storage,
}: {
  readonly pending: PendingFileState;
  readonly storage: StorageEnv;
}) {
  const { file, saving, message, save } = pending;
  return (
    <>
      {message && (
        <p
          className={message.kind === 'error' ? 'notice error' : 'notice'}
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
      {file !== null && (
        <div className="notice warning" role="status">
          <p>
            The updated fleet file is not saved yet. Only this browser holds the latest changes:
            save the fleet file to keep them.
          </p>
          {!supportsDirectoryPicker(storage) && (
            <p className="muted">Your browser will download the file. Check “Downloads” then.</p>
          )}
          <div className="actions">
            <Button variant="primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save the fleet file'}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
