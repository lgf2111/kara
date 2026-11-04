import { useState, type ChangeEvent, type DragEvent } from 'react';

interface DropZoneProps {
  readonly onFiles: (files: readonly File[]) => void;
  /** What it says for itself, which differs on the stage and in the drawer. */
  readonly heading?: string;
  /** Extra class, so the same target can be the whole stage or a block in a list. */
  readonly className?: string;
}

/** Drop files or pick them. There is no third way in by design. */
export function DropZone({ onFiles, heading, className }: DropZoneProps) {
  const [over, setOver] = useState(false);

  const take = (picked: FileList | null): void => {
    const files = picked === null ? [] : [...picked];
    if (files.length > 0) {
      onFiles(files);
    }
  };

  return (
    <div
      className={`drop${className === undefined ? '' : ` ${className}`}${over ? ' over' : ''}`}
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
        take(event.dataTransfer.files);
      }}
    >
      <p className="ask">{heading ?? 'Drop a song you own, or choose a file.'}</p>
      <label className="pick">
        choose a file
        <input
          type="file"
          accept="audio/*,video/*"
          // Several at once queue up: one separation already takes the whole
          // machine, so they are analysed in the order they arrived.
          multiple
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            take(event.target.files);
            // Cleared so picking the same file again still fires a change,
            // which is how a stopped job is carried on.
            event.target.value = '';
          }}
        />
      </label>
      <p className="note">
        The file plays here and is separated here. It is never uploaded, and no link or search can
        bring media in.
      </p>
    </div>
  );
}
