# Reading lyrics off a video

Status: M3a. Some songs arrive as a video with the words already burned into the picture. This
reads them back out, in the browser, and keeps them with the song. It is the first of M3's lyric
paths; transcription and paste-to-align are still to come.

## What it does

For a song whose own video is kept, the library offers **read lyrics from the video**. Three passes:

1. **Find the words.** 30 frames spread over the video are drawn to a canvas, downscaled to 480 px
   wide and turned to grey. For each row, the mean absolute brightness change along it is measured.
   A row crossing text steps between stroke and background several times a character, which no
   amount of sky or gradient does. Rows that are busy in frame after frame are grouped into bands
   and ranked: a lyric line is the one thing that stays in the same place all video.
2. **Choose where to look.** The best three bands are cropped out of six frames each, upscaled,
   contrast stretched and inverted, and run through OCR. The band with the most confident readings
   wins. OCR has the last word because row energy cannot tell a lyric from a chyron.
3. **Read the words.** The video is worked through at 2 frames a second, cropped to that band.
   Runs of frames that read the same become one line with a start and an end, and holes of up to
   0.75 s inside a line are closed.

The band has to be found rather than assumed. The node spike ran OCR on whole 1080p frames of a
lyric video and read **nothing at all**: one thin line of small capitals at low contrast, which
page segmentation threw away as noise. Cropped to its own band and upscaled, the same video gave
**57 lines covering 86% of it at 92.7 mean confidence**.

## Where the parts live

| | |
| --- | --- |
| `apps/web/src/lyrics/lines.ts` | frames to timed lines; a port of `scripts/lib/lyric-ocr.mjs` |
| `apps/web/src/lyrics/pixels.ts` | grey, row energy, and the crop preparation |
| `apps/web/src/lyrics/bands.ts` | ranking the bands and picking between them |
| `apps/web/src/lyrics/frames.ts` | frames out of the file, through a video element and a canvas |
| `apps/web/src/lyrics/ocr.worker.ts` | tesseract.js, one crop at a time |
| `apps/web/src/lyrics/read.ts` | the three passes, with progress and cancel |

The node spike, `scripts/spike/lyric-ocr.mjs` and `scripts/lib/lyric-ocr.mjs`, stays as it is: it
is the record of the measurement above. Keep the port and the original in step when either changes.

A video element rather than WebCodecs, because WebCodecs wants the container demuxed first and
nothing in the browser will demux an mp4. Seeking is slower, but a seek costs a rounding error
next to the OCR of the frame it produces.

## The traineddata, and why none of it comes from a CDN

tesseract.js fetches three things at runtime, and by default takes all three from jsdelivr. That
would break `connect-src 'self'`, so each one is served from this origin instead, by routes in
`apps/web/vite.config.ts`:

| URL | From |
| --- | --- |
| `/tesseract/worker.min.js` | `node_modules/tesseract.js/dist` |
| `/tesseract/core/*` | `node_modules/tesseract.js-core` |
| `/tesseract/tessdata/eng.traineddata` | `models/tessdata`, which is gitignored |

The first two come with the dependency. The third does not, and is not committed: a language model
is a weight file, which `scripts/check-no-media.mjs` refuses. Put it in place once, from the
Tesseract project's own data repository:

```
mkdir -p models/tessdata
curl -L -o models/tessdata/eng.traineddata \
  https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata
```

`tessdata_fast` (about 4 MB, Apache-2.0) is the integer model and is what the node spike measured
with. `tessdata_best` reads a little better and costs about 23 MB; either works, under the same
name. Nothing fetches it for you, and nothing in the app will reach for a CDN if it is missing: the
read fails and says where to put the file.

These routes are dev-server routes, the same arrangement `/weights` has. Production serving is the
open question M1 left: Cloudflare Pages caps one asset at 25 MiB, so expect the same answer for
both, which is R2 behind the same host so `connect-src 'self'` stays true.

## Where the lines go, and where they do not

The lines are kept on the song record in IndexedDB, as
`lyrics: { lines: [{ startMs, endMs, text }], source: 'video-ocr', readAt }`. Database version 2
added the field; a record written by version 1 simply has none, which is what a song nobody has
read looks like anyway. **Remove lyrics** deletes the field and nothing else.

They stay on the device. A recipe carries timings, and lyric text only when the person exporting
ticks the box, which is the rule `docs/DESIGN.md` already sets for transcription.

No recognised text is ever logged. A read prints one line of counts and timings when it finishes,
and that is the only thing it prints. The same rule holds in the tests: every string in
`apps/web/test/lyric-*.test.ts` is a placeholder, and the OCR slips are spelt by hand.
