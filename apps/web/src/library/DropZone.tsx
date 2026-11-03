import { useState, type ChangeEvent, type DragEvent } from 'react';

interface DropZoneProps {
  readonly busy: boolean;
  readonly onFile: (file: File) => void;
}

/** Drop a file or pick one. There is no third way in by design. */
export function DropZone({ busy, onFile }: DropZoneProps) {
  const [over, setOver] = useState(false);

  const take = (file: File | undefined): void => {
    if (file !== undefined && !busy) {
      onFile(file);
    }
  };

  return (
    <div
      className={over ? 'drop over' : 'drop'}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setOver(false);
        take(event.dataTransfer.files[0]);
      }}
    >
      <p>Drop an audio or video file you own here.</p>
      <label className="pick">
        or choose a file
        <input
          type="file"
          accept="audio/*,video/*"
          disabled={busy}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            take(event.target.files?.[0]);
            // Cleared so picking the same file again still fires a change,
            // which is how a paused song is carried on.
            event.target.value = '';
          }}
        />
      </label>
      <p className="note">
        The file is decoded and separated in this tab. It is never uploaded, and no link or search
        can bring media in.
      </p>
    </div>
  );
}
