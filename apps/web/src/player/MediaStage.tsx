import { useCallback, useEffect, useState } from 'react';

import type { SourceKind } from '../library/songs.ts';
import { MediaSurface, type MediaSurfaceProps } from './MediaSurface.tsx';

interface MediaStageProps extends Omit<MediaSurfaceProps, 'picture' | 'onLosePicture'> {
  readonly kind: SourceKind;
}

/**
 * Whether this file still has a picture worth showing, around the stage that
 * shows it.
 *
 * Only this one question lives here, because answering it has to replace the
 * element underneath. The clock, the volume, the keyboard and the stems all
 * hang off that element, so the stage is remounted rather than switched:
 * every one of them is then bound to the audio element instead of the video,
 * and none of them has to know that a fallback exists.
 *
 * It only ever happens before a frame has played — {@link videoRemedy} says
 * so — which is why remounting costs the room nothing.
 */
export function MediaStage({ url, kind, ...rest }: MediaStageProps) {
  const [picture, setPicture] = useState(kind === 'video');

  useEffect(() => {
    // A new file gets the benefit of the doubt. What could not be decoded was
    // this browser's trouble with those bytes, not with every video.
    setPicture(kind === 'video');
  }, [kind, url]);

  const losePicture = useCallback((): void => {
    setPicture(false);
  }, []);

  return (
    <MediaSurface
      key={picture ? 'video' : 'audio'}
      url={url}
      picture={picture}
      onLosePicture={losePicture}
      {...rest}
    />
  );
}
