import { HardDrive, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { DrawerNotes } from './DrawerNotes.tsx';
import { DropZone } from './DropZone.tsx';
import { QueuePanel } from './QueuePanel.tsx';
import { SongList } from './SongList.tsx';
import { describeStorage, formatBytes } from './format.ts';
import type { SongRecord } from './songs.ts';
import { totalBytes } from './storage.ts';
import type { Library } from './useLibrary.ts';

interface DrawerProps {
  readonly open: boolean;
  readonly library: Library;
  readonly onClose: () => void;
  readonly onPlay: (song: SongRecord) => void;
  readonly onFiles: (files: readonly File[]) => void;
  readonly onDelete: (song: SongRecord) => void;
  readonly onRemoveLyrics: (song: SongRecord) => void;
}

/**
 * The library, over the stage rather than instead of it.
 *
 * A song is still playing behind this, which is the point: putting the next
 * one on, reading lyrics off one, or seeing what the device is holding should
 * not stop the room. It slides over, does its job and goes away.
 */
export function Drawer({
  open,
  library,
  onClose,
  onPlay,
  onFiles,
  onDelete,
  onRemoveLyrics,
}: DrawerProps) {
  const songCount = library.songs.length;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // Escape and a press on the song behind both land here, which is how
        // a drawer is usually shut.
        if (!next) {
          onClose();
        }
      }}
    >
      <SheetContent
        side="left"
        showCloseButton={false}
        className="w-full gap-0 overflow-y-auto border-white/10 bg-background/95 backdrop-blur-xl sm:max-w-md"
      >
        <SheetHeader className="gap-1 px-5 pt-5 pb-0">
          <SheetTitle className="font-heading text-2xl tracking-tight">Kara</SheetTitle>
          <SheetDescription>Songs you own, kept on this device.</SheetDescription>
          <SheetClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="close the songs"
                className="absolute top-4 right-4"
              />
            }
          >
            <X aria-hidden="true" />
          </SheetClose>
        </SheetHeader>

        <div className="space-y-5 p-5">
          <DropZone heading="Drop another song you own, or choose a file." onFiles={onFiles} />

          {library.error !== null && (
            <div className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3">
              <p className="text-sm text-foreground">{library.error}</p>
              <Button variant="ghost" size="sm" onClick={library.dismissError}>
                dismiss
              </Button>
            </div>
          )}

          <QueuePanel library={library} />

          <Separator />

          <section className="space-y-3">
            <h2 className="text-[0.7rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
              Songs
            </h2>
            <SongList
              songs={library.songs}
              sizes={library.sizes}
              busy={library.active !== null}
              lyricsJob={library.lyricsJob}
              cancellingLyrics={library.cancellingLyrics}
              onPlay={onPlay}
              onDelete={onDelete}
              onReadLyrics={library.readLyrics}
              onCancelLyrics={library.cancelLyrics}
              onRemoveLyrics={onRemoveLyrics}
            />
          </section>

          <Separator />

          <section className="space-y-1">
            <h2 className="text-[0.7rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
              Storage
            </h2>
            <p className="flex items-center gap-2 text-sm">
              <HardDrive className="size-4 flex-none text-muted-foreground" aria-hidden="true" />
              {formatBytes(totalBytes(library.sizes))} across {String(songCount)}{' '}
              {songCount === 1 ? 'song' : 'songs'}, all of it on this device.
            </p>
            <p className="text-xs text-muted-foreground">
              {describeStorage(library.usageBytes, library.quotaBytes)}
            </p>
          </section>

          <Separator />

          <DrawerNotes />
        </div>
      </SheetContent>
    </Sheet>
  );
}
