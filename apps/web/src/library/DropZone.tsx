import { useState, type ChangeEvent, type DragEvent } from 'react';
import { Upload } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DropZoneProps {
  readonly onFiles: (files: readonly File[]) => void;
  /** What it says for itself, which differs on the stage and in the drawer. */
  readonly heading?: string;
  /**
   * How much room it has. On an empty stage it is the whole invitation; in
   * the drawer it is one block among the songs already there.
   */
  readonly size?: 'stage' | 'panel';
}

/** Drop files or pick them. There is no third way in by design. */
export function DropZone({ onFiles, heading, size = 'panel' }: DropZoneProps) {
  const [over, setOver] = useState(false);
  const stage = size === 'stage';

  const take = (picked: FileList | null): void => {
    const files = picked === null ? [] : [...picked];
    if (files.length > 0) {
      onFiles(files);
    }
  };

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02] text-center transition-colors',
        over && 'border-white/60 bg-white/[0.06]',
        stage
          ? 'w-[min(42rem,100%)] justify-center px-6 py-10 sm:min-h-[min(22rem,60vh)]'
          : 'px-4 py-5',
      )}
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
      <span
        className={cn(
          'flex items-center justify-center rounded-full bg-white/5 text-white/70 ring-1 ring-white/10 ring-inset',
          stage ? 'size-16' : 'size-10',
        )}
        aria-hidden="true"
      >
        <Upload className={stage ? 'size-7' : 'size-4'} />
      </span>

      <p
        className={cn(
          'font-semibold tracking-tight text-white',
          stage ? 'text-xl sm:text-2xl' : 'text-sm',
        )}
      >
        {heading ?? 'Drop a song you own, or choose a file.'}
      </p>

      {/*
        The input is taken out of sight rather than hidden: the label is the
        button, and the input still takes the focus ring and the keyboard.
      */}
      <label
        className={cn(
          buttonVariants({ variant: 'secondary', size: stage ? 'lg' : 'default' }),
          'cursor-pointer focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
        )}
      >
        choose a file
        <input
          type="file"
          accept="audio/*,video/*"
          // Several at once queue up: one separation already takes the whole
          // machine, so they are analysed in the order they arrived.
          multiple
          className="sr-only"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            take(event.target.files);
            // Cleared so picking the same file again still fires a change,
            // which is how a stopped job is carried on.
            event.target.value = '';
          }}
        />
      </label>

      <p className="max-w-md text-xs leading-relaxed text-white/45">
        The file plays here and is separated here. It is never uploaded, and no link or search can
        bring media in.
      </p>
    </div>
  );
}
